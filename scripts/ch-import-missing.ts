// Targeted, INSERT-ONLY import of a fixed list of company numbers from a Companies House monthly file.
//
//   DRY RUN (default - writes nothing, makes no API calls):
//     npm run ch:import-missing -- --zip <BasicCompanyData...zip> --numbers <list.txt> [--expected 1080] [--report <dir>]
//   REAL RUN (only after explicit approval; needs a verified backup and a confirmation token):
//     npm run ch:import-missing -- --zip <zip> --numbers <list.txt> --expected 1080 --execute \
//        --backup <dump file> --confirm IMPORT-<count>
//
// Guarantees:
//   * Only rows whose number is in the list, whose row maps with the project's own mapper (mapCsvRecord, which
//     applies the UK-only eligibility rule), and which are NOT already in the database are inserted.
//   * INSERT ... ON CONFLICT ("companyNumber") DO NOTHING: an existing row is never updated, deleted or reclassified.
//   * The real run is one transaction: any failure rolls back everything. It refuses to run unless the dry-run counts
//     match --expected exactly (every listed number found, mapped, eligible and absent).
//   * Touches the Company table only (same columns/source tag as the monthly bulk importer).
import { parse } from "csv-parse";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../src/lib/db";
import { emptyMappingStats, mapCsvRecord, missingColumns, type CompanyCsvRow } from "../src/lib/companies-house/csv/mapping";
import { openCsvFile } from "../src/lib/companies-house/csv/source";
import { isNonUkCompany } from "../src/lib/companies-house/eligibility";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};

// Same column list / value order as the monthly bulk importer (src/lib/companies-house/bulkIngest.ts).
const COLUMNS = [
  "id", "companyNumber", "name", "status", "statusDetail", "type", "incorporationDate", "dissolutionDate",
  "dormant", "accountType", "sicCodes", "registeredAddress1", "registeredAddress2", "registeredCity",
  "registeredPostcode", "registeredCounty", "accountsNextDue", "accountsLastMadeUp", "accountsOverdue",
  "confirmationNextDue", "confirmationLastMadeUp", "confirmationOverdue", "hasDS01", "source",
  "chLastFetchedAt", "createdAt", "updatedAt",
];
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
function tuple(r: CompanyCsvRow, now: string): Prisma.Sql {
  return Prisma.sql`(${randomUUID()}, ${r.companyNumber}, ${r.name}, ${r.status}, ${r.statusDetail}, ${r.type},
    ${iso(r.incorporationDate)}::date, ${iso(r.dissolutionDate)}::date, ${r.dormant}, ${r.accountType},
    ${r.sicCodes}, ${r.registeredAddress1}, ${r.registeredAddress2}, ${r.registeredCity}, ${r.registeredPostcode},
    ${r.registeredCounty}, ${iso(r.accountsNextDue)}::date, ${iso(r.accountsLastMadeUp)}::date, ${r.accountsOverdue},
    ${iso(r.confirmationNextDue)}::date, ${iso(r.confirmationLastMadeUp)}::date, ${r.confirmationOverdue},
    ${r.hasDS01}, 'bulk_import', CAST(${now} AS timestamp), CAST(${now} AS timestamp), CAST(${now} AS timestamp))`;
}

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});

async function main() {
  const zip = val("--zip");
  const listFile = val("--numbers");
  if (!zip || !listFile) throw new Error("--zip and --numbers are required");
  const execute = has("--execute");
  const expected = val("--expected") ? Number(val("--expected")) : undefined;
  const reportDir = val("--report") ?? path.dirname(listFile);

  const wanted = new Set(fs.readFileSync(listFile, "utf8").split(/\r?\n/).map((s) => s.trim().toUpperCase()).filter(Boolean));
  console.log(`mode: ${execute ? "EXECUTE" : "DRY RUN (no writes)"}; numbers listed: ${wanted.size}; file: ${zip}`);

  // 1. Read the monthly file, keep only listed numbers.
  const source = await openCsvFile(zip);
  const parser = source.stream.pipe(parse({
    columns: (h: string[]) => {
      const t = h.map((x) => x.trim());
      const miss = missingColumns(t);
      if (miss.length) throw new Error(`CSV missing columns: ${miss.join(", ")}`);
      return t;
    },
    skip_empty_lines: true, trim: true, bom: true, relax_column_count: true,
  }));
  const stats = emptyMappingStats();
  const mapped = new Map<string, CompanyCsvRow>();
  const notMapped: { n: string; reason: string }[] = [];
  const dupInFile: string[] = [];
  const seenWanted = new Set<string>();
  let read = 0;
  for await (const rec of parser as AsyncIterable<Record<string, string>>) {
    read++;
    const n = (rec["CompanyNumber"] ?? "").trim().toUpperCase();
    if (!wanted.has(n)) continue;
    if (seenWanted.has(n)) { dupInFile.push(n); continue; }
    seenWanted.add(n);
    const m = mapCsvRecord(rec, stats);
    if (m.ok) mapped.set(n, m.row);
    else notMapped.push({ n, reason: m.reason });
  }
  source.close();
  const notInFile = [...wanted].filter((n) => !seenWanted.has(n));

  // 2. Re-verify against the CURRENT database (read-only).
  const present = new Set<string>();
  const nums = [...wanted];
  for (let i = 0; i < nums.length; i += 1000) {
    const rows = await db.$queryRaw<{ n: string }[]>(Prisma.sql`SELECT "companyNumber" AS n FROM "Company" WHERE "companyNumber" IN (${Prisma.join(nums.slice(i, i + 1000))})`);
    rows.forEach((r) => present.add(r.n));
  }
  const dbTotalBefore = Number((await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM "Company"`))[0].n);

  const nonUk = [...mapped.values()].filter((r) => isNonUkCompany({ companyNumber: r.companyNumber, type: r.type }));
  const toInsert = [...mapped.values()].filter((r) => !present.has(r.companyNumber) && !isNonUkCompany({ companyNumber: r.companyNumber, type: r.type }));
  const alreadyPresent = [...mapped.keys()].filter((n) => present.has(n));

  const summary = {
    csvRowsRead: read, listed: wanted.size, foundInFile: seenWanted.size, notInFile: notInFile.length, dupInFile: dupInFile.length,
    mappedOk: mapped.size, notMapped: notMapped.length, ineligibleNonUk: nonUk.length,
    alreadyInDatabase: alreadyPresent.length, wouldInsert: toInsert.length, wouldUpdate: 0, wouldDelete: 0,
    byStatus: tally(toInsert.map((r) => r.status)), byType: tally(toInsert.map((r) => r.type)),
    byIncYear: tally(toInsert.map((r) => String(r.incorporationDate?.getUTCFullYear()))),
    nullIncorporation: toInsert.filter((r) => !r.incorporationDate).length,
    mappingStats: stats, dbCompanyCountNow: dbTotalBefore,
  };
  console.log(JSON.stringify(summary, null, 1));
  if (notInFile.length) console.log("not in file:", notInFile.slice(0, 20));
  if (notMapped.length) console.log("not mapped:", notMapped.slice(0, 20));
  if (alreadyPresent.length) console.log("already in DB (will be skipped):", alreadyPresent.slice(0, 20));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync(reportDir, { recursive: true });
  const csv = ["companyNumber,name,status,type,incorporationDate,postcode",
    ...toInsert.map((r) => [r.companyNumber, JSON.stringify(r.name), r.status, r.type, iso(r.incorporationDate) ?? "", r.registeredPostcode ?? ""].join(","))].join("\n");
  const planFile = path.join(reportDir, `import-missing-${execute ? "EXECUTED" : "dryrun"}-${stamp}.csv`);
  fs.writeFileSync(planFile, csv + "\n");
  fs.writeFileSync(planFile.replace(/\.csv$/, ".json"), JSON.stringify(summary, null, 1));
  console.log(`plan written: ${planFile}`);

  const exact = expected === undefined || (toInsert.length === expected && wanted.size === expected && alreadyPresent.length === 0 && notInFile.length === 0 && notMapped.length === 0 && nonUk.length === 0 && dupInFile.length === 0);
  console.log(expected === undefined ? "no --expected given" : exact ? `MATCHES expectation: ${expected} inserts, 0 updates` : `DOES NOT MATCH expectation of ${expected}`);

  if (!execute) { console.log("DRY RUN complete - nothing was written."); return; }

  // 3. Real run: hard gates.
  const backup = val("--backup");
  if (!backup || !fs.existsSync(backup) || fs.statSync(backup).size < 1_000_000_000) throw new Error("--backup must point to an existing full dump (>1 GB)");
  if (expected === undefined || !exact) throw new Error("refusing to execute: dry-run counts do not match --expected");
  if (val("--confirm") !== `IMPORT-${toInsert.length}`) throw new Error(`refusing to execute: pass --confirm IMPORT-${toInsert.length}`);
  const now = new Date().toISOString();
  const inserted = await db.$transaction(async (tx) => {
    let n = 0;
    for (let i = 0; i < toInsert.length; i += 200) {
      const chunk = toInsert.slice(i, i + 200);
      const out = await tx.$queryRaw<{ n: string }[]>(Prisma.sql`
        INSERT INTO "Company" (${Prisma.join(COLUMNS.map((c) => Prisma.raw(`"${c}"`)))})
        VALUES ${Prisma.join(chunk.map((r) => tuple(r, now)))}
        ON CONFLICT ("companyNumber") DO NOTHING RETURNING "companyNumber" AS n`);
      n += out.length;
    }
    if (n !== toInsert.length) throw new Error(`inserted ${n} != planned ${toInsert.length}; rolling back`);
    return n;
  }, { timeout: 120_000 });
  console.log(`INSERTED ${inserted} companies (existing rows untouched).`);
}

main().catch((e) => { console.error("FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => db.$disconnect());
