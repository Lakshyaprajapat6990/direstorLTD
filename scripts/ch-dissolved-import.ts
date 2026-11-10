// Dissolved / historical company import (Companies House Advanced Search API).
//   The monthly bulk file holds LIVE companies only; this fills in the rest of the register.
//
//   npm run ch:dissolved-import -- --dry-run --from 2015-03-01 --to 2015-03-07     (fetch + predict, writes nothing)
//   npm run ch:dissolved-import -- --from 2015-03-01 --to 2015-03-07               (import a slice)
//   npm run ch:dissolved-import -- --all                                           (whole register, resumable)
//   npm run ch:dissolved-import -- --all --resume <runId>
//   npm run ch:dissolved-import -- --adaptive --dissolved-since 2026-10-01          (only companies dissolved since a day: a few dozen requests)
//   npm run ch:dissolved-import -- --adaptive --status converted-closed             (one small status: a few dozen requests)
//   npm run ch:dissolved-import -- --adaptive --reconcile-live --status liquidation  (also correct stored companies now in a live non-active status)
//   Options: --status dissolved (default) | converted-closed | removed | closed ...  --max-requests N
import { importDissolved } from "../src/lib/companies-house/dissolvedImport";
import { db } from "../src/lib/db";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("dissolved-import");
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const val = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("\nInterrupt received - finishing the current request, then stopping (the run stays resumable)...");
    controller.abort();
  });
}

async function main() {
  const from = val("--from");
  const to = val("--to");
  if (!has("--all") && !has("--adaptive") && !from) {
    console.log("Nothing to do. Use --from/--to for a slice or --all for the whole register (see the header of this file).");
    return;
  }
  const result = await importDissolved({
    status: val("--status"),
    from,
    to,
    resumeRunId: val("--resume"),
    dryRun: has("--dry-run"),
    adaptive: has("--adaptive"),
    reconcileLive: has("--reconcile-live"),
    dissolvedSince: val("--dissolved-since"),
    maxRequests: val("--max-requests") ? Number(val("--max-requests")) : undefined,
    signal: controller.signal,
    log: (m) => logger.info(m.trim()),
  });
  logger.info("Dissolved import finished", { ...result });
  if (result.status === "failed") process.exitCode = 1;
}

main()
  .then(() => db.$disconnect())
  .then(() => process.exit(process.exitCode ?? 0))
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
