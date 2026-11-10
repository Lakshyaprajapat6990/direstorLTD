// Removes companies that are not UK companies (overseas entities, overseas companies, UK establishments) from the register.
// The rule is src/lib/companies-house/eligibility.ts: the same one every ingestion pipeline now applies, so this is a one-off
// cleanup of what was imported before the rule existed, and a safe repeat if a stale process ever stores one again.
//
//   npm run ch:remove-non-uk                                  DRY RUN (default): counts what would go, changes nothing
//   npm run ch:remove-non-uk -- --apply --backup <dump file>  deletes, in small committed batches, after an audit export
//   Options: --batch N (default 1000)   --pause-ms N (default 750)   --export <csv path> (default next to the backup)
//            --keep <file>  company numbers (one per line) that must NOT be deleted: records whose eligibility is still ambiguous
//
// Safety:
//   - --apply refuses to run unless --backup names an existing pg_dump file of a plausible size.
//   - Every deleted company is first written to a CSV (number, name, type, status, source) so the removal is auditable.
//   - Each batch is its own short transaction (cascade removes only that company's own director rows, officer-queue row, CRM
//     contacts, notes, follow-ups, assignments and recently-viewed rows); no user account, report, customer or unrelated data is touched.
//     Activity-log and customer-view rows keep their plain company ids by design (no foreign key).
//   - The delete runs at a low rate so the officer worker and the schedulers sharing this database are never starved.
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { NON_UK_SQL_PREDICATE } from "../src/lib/companies-house/eligibility";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("remove-non-uk");
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// Companies that match the rule AND are not on the keep list (ambiguous ones are never deleted).
let keep: string[] = [];
const KEEP = `AND "companyNumber" <> ALL($1::text[])`;
const target = () => `"source" <> 'seed' AND ${NON_UK_SQL_PREDICATE} ${KEEP}`;

async function counts() {
  const rows = await db.$queryRawUnsafe<{ type: string; status: string; n: bigint }[]>(
    `SELECT "type", "status", count(*) AS n FROM "Company" WHERE ${target()} GROUP BY 1, 2 ORDER BY 3 DESC`, keep,
  );
  const dep = await db.$queryRawUnsafe<{ k: string; n: bigint }[]>(
    `WITH t AS (SELECT id FROM "Company" WHERE ${target()})
     SELECT 'Director' k, count(*) n FROM "Director" d JOIN t ON t.id = d."companyId"
     UNION ALL SELECT 'OfficerSyncJob', count(*) FROM "OfficerSyncJob" d JOIN t ON t.id = d."companyId"
     UNION ALL SELECT 'UserCompanyState', count(*) FROM "UserCompanyState" d JOIN t ON t.id = d."companyId"
     UNION ALL SELECT 'CrmContact', count(*) FROM "CrmContact" d JOIN t ON t.id = d."companyId"
     UNION ALL SELECT 'ContactLog', count(*) FROM "ContactLog" d JOIN t ON t.id = d."companyId"
     UNION ALL SELECT 'Assignment', count(*) FROM "Assignment" d JOIN t ON t.id = d."companyId"
     UNION ALL SELECT 'RecentlyViewed', count(*) FROM "RecentlyViewed" d JOIN t ON t.id = d."companyId"
     UNION ALL SELECT 'FilingEvent (company link set to null)', count(*) FROM "FilingEvent" d JOIN t ON t.id = d."companyId"`, keep,
  );
  return { rows: rows.map((r) => ({ type: r.type, status: r.status, n: Number(r.n) })), dep: dep.map((d) => ({ k: d.k, n: Number(d.n) })) };
}

async function main() {
  const apply = has("--apply");
  const batch = Math.max(1, Math.min(5000, Number(val("--batch") ?? 1000)));
  const pause = Math.max(0, Number(val("--pause-ms") ?? 750));

  const keepFile = val("--keep");
  if (keepFile) keep = fs.readFileSync(keepFile, "utf8").split(/\s+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
  logger.info(`Keep list (ambiguous, never deleted): ${keep.length} company numbers`);
  const before = await counts();
  const total = before.rows.reduce((s, r) => s + r.n, 0);
  logger.info(`Non-UK companies stored: ${total}`);
  for (const r of before.rows) logger.info(`  ${r.type} / ${r.status}: ${r.n}`);
  for (const d of before.dep) logger.info(`  dependent ${d.k}: ${d.n}`);
  if (!apply) {
    logger.info("Dry run: nothing changed. Re-run with --apply --backup <dump file> to delete.");
    return;
  }

  const backup = val("--backup");
  if (!backup || !fs.existsSync(backup) || fs.statSync(backup).size < 100 * 1024 * 1024) {
    throw new Error("--apply needs --backup <an existing pg_dump file (at least 100 MB)>. Take and verify a backup first.");
  }
  if (total === 0) {
    logger.info("Nothing to delete.");
    return;
  }

  // Audit trail first: every company about to be removed.
  const exportPath = val("--export") ?? path.join(path.dirname(backup), `removed-non-uk-companies-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  const audit = await db.$queryRawUnsafe<{ companyNumber: string; name: string; type: string; status: string; source: string }[]>(
    `SELECT "companyNumber", "name", "type", "status", "source" FROM "Company" WHERE ${target()} ORDER BY "companyNumber"`, keep,
  );
  fs.writeFileSync(exportPath, ["companyNumber,name,type,status,source", ...audit.map((a) => [a.companyNumber, a.name, a.type, a.status, a.source].map(csvCell).join(","))].join("\n"), "utf8");
  logger.info(`Audit export written: ${exportPath} (${audit.length} rows). Backup: ${backup}`);

  let deleted = 0;
  for (;;) {
    const n = await db.$executeRawUnsafe(
      `DELETE FROM "Company" WHERE "id" IN (SELECT "id" FROM "Company" WHERE ${target()} LIMIT ${batch})`, keep,
    );
    if (n === 0) break;
    deleted += n;
    if (deleted % (batch * 5) === 0 || n < batch) logger.info(`  deleted ${deleted} / ${total}`);
    if (pause) await sleep(pause);
  }

  const after = await counts();
  const left = after.rows.reduce((s, r) => s + r.n, 0);
  logger.info(`Deleted ${deleted}. Non-UK companies still stored: ${left}`);
  if (left > 0) process.exitCode = 1;
}

main()
  .then(() => db.$disconnect())
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
