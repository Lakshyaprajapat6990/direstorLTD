// Read-only monitoring snapshot: scheduler heartbeat, per-source freshness, officer queue depth and the health verdict.
//   npm run jobs:status               print the snapshot as JSON (exit 0)
//   npm run jobs:status -- --check    exit 1 when the verdict is "degraded" (use it from a monitoring task)
// It writes nothing and calls no external API. Secrets are never printed (only host:port/database).
import "./load-env";
import { getIngestionFreshness } from "../src/lib/data/freshness";
import { evaluateHealth } from "../src/lib/jobs/health";
import { describeDatabaseUrl } from "../src/lib/jobs/schedulerGuard";
import { isRestConfigured, isStreamConfigured } from "../src/lib/companies-house/client";
import { effectiveStatus } from "../src/lib/jobs/runs";
import { db } from "../src/lib/db";

async function main() {
  const now = new Date();
  const target = describeDatabaseUrl(process.env.DATABASE_URL);
  const [freshness, runs, pending, queue] = await Promise.all([
    getIngestionFreshness(),
    db.ingestionRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }),
    db.filingEvent.count({ where: { applyStatus: "pending", type: { in: ["DS01", "DS02"] } } }),
    db.officerSyncJob.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const verdict = evaluateHealth({
    now,
    freshness,
    schedulerExpected: process.env.SCHEDULER_EXPECTED === "1",
    restConfigured: isRestConfigured(),
    stalledJobs: runs.filter((r) => effectiveStatus(r) === "stalled").length,
    pendingDs01Events: pending,
    stream: { configured: isStreamConfigured(), status: "n/a", lastEventAgeSeconds: null },
  });
  console.log(
    JSON.stringify(
      {
        checkedAt: now.toISOString(),
        database: target ? `${target.host}:${target.port}/${target.database}` : "unknown",
        verdict,
        scheduler: freshness.scheduler,
        sources: { registrations: freshness.registrations, dissolved: freshness.dissolved, statusReconcile: freshness.statusReconcile, bulk: freshness.bulk, daily: freshness.daily, officers: freshness.officers },
        officerQueue: Object.fromEntries(queue.map((q) => [q.status, q._count._all])),
        recentRuns: runs.slice(0, 10).map((r) => ({ kind: r.kind, status: effectiveStatus(r), startedAt: r.startedAt, finishedAt: r.finishedAt, read: r.rowsRead, inserted: r.rowsInserted, updated: r.rowsUpdated, error: r.errorMessage?.slice(0, 160) ?? null })),
      },
      null,
      2
    )
  );
  if (process.argv.includes("--check") && verdict.degraded) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  })
  .finally(() => db.$disconnect().then(() => process.exit(process.exitCode ?? 0)));
