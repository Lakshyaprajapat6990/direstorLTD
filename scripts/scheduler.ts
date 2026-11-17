// Background scheduler. Runs INDEPENDENTLY of the Next.js website, from the repository root:
//   npm run jobs:scheduler            persistent process (supervise it: scripts/run-production-scheduler.ps1 / .sh)
//   npm run jobs:once                 ONE pass over every due job, then exit (for Plesk / OS scheduled tasks)
//   npm run jobs:once -- --with-monthly   ...also run the monthly bulk file if it is due (can take hours)
//
// Jobs (each is explicit and env-controlled; the defaults are unchanged for the existing local supervisors):
// - new registrations (ON whenever COMPANIES_HOUSE_API_KEY is set; NEW_REGISTRATIONS_ENABLED=0 turns it off): every
//   NEW_REGISTRATIONS_INTERVAL_HOURS (default 6) it fetches companies incorporated since the last covered day
//   (src/lib/companies-house/newRegistrations.ts). A failed run is simply resumed by the next one.
// - daily update at DAILY_UPDATE_UTC_HOUR (default 03:00 UTC), once per UTC day. This is MAINTENANCE only (overdue flags,
//   pending DS01 events, officer queueing, report refresh): it imports no company data. DAILY_MAX_ATTEMPTS=0 switches it off.
// - dissolved refresh (OFF; DISSOLVED_REFRESH_ENABLED=1): once per UTC day, after DISSOLVED_REFRESH_UTC_HOUR (default 04:00).
//   Companies dissolved since the last refresh, via the existing adaptive importer (src/lib/jobs/dissolvedRefresh.ts).
// - status reconcile (OFF; STATUS_RECONCILE_ENABLED=1): every STATUS_RECONCILE_INTERVAL_DAYS (default 7), brings stored
//   companies in line with the register for STATUS_RECONCILE_STATUSES (default liquidation,administration).
// - monthly bulk CSV on MONTHLY_INGEST_DAY (default the 3rd) at MONTHLY_INGEST_UTC_HOUR (default 04:00 UTC) - ONLY if
//   MONTHLY_INGEST_ENABLED=1. Publication-aware and resumable: it runs only when the newest PUBLISHED file is newer than
//   the snapshot already loaded, and an interrupted load is resumed, not restarted.
// - officer worker (OFF by default): OFFICER_WORKER_ENABLED=1 keeps the officer sync worker running (queued work first);
//   OFFICER_CRAWL_ENABLED=1 additionally lets it walk the background crawl. OFFICER_DAILY_REQUEST_CAP bounds its requests.
// - filing stream (OFF by default; persistent mode only): STREAM_WORKER_ENABLED=1. Companies House allows ONE stream
//   connection per key, so never also run `npm run ch:stream`.
//
// Safety:
// - Database guard (C7): in production SCHEDULER_EXPECTED_DB_HOST + SCHEDULER_EXPECTED_DB_NAME must match DATABASE_URL.
// - Lease + heartbeat (C8): one IngestionRun row of kind "scheduler" per process; a second scheduler that wants a job another
//   live scheduler owns refuses to start (exit code 3). Disjoint job sets may share a database (the local setup does).
// - Every Companies House request goes through the shared quota gate; jobs are restart-safe because every decision is read
//   from the run table, never from memory.
// Exit codes: 0 ok / graceful stop, 1 unexpected error, 2 database guard refused, 3 another scheduler owns these jobs.
import "./load-env"; // FIRST: loads <repo>/.env (never overriding real environment variables) before anything reads process.env
import fs from "node:fs";
import os from "node:os";
import { runDailyUpdate } from "../src/lib/companies-house/dailyUpdate";
import { bulkIngestFromCsv, snapshotDateFromName } from "../src/lib/companies-house/bulkIngest";
import { resolveLatestMonthlyUrl } from "../src/lib/companies-house/csv/source";
import { runStreamWorker } from "../src/lib/companies-house/streamWorker";
import { syncNewRegistrations } from "../src/lib/companies-house/newRegistrations";
import { isRestConfigured, isStreamConfigured } from "../src/lib/companies-house/client";
import { restartDelayMs, runOfficerWorker } from "../src/lib/companies-house/officerWorker";
import { JobAlreadyRunningError, reconcileStaleRuns } from "../src/lib/jobs/runs";
import { describeDatabaseUrl, evaluateSchedulerDbGuard } from "../src/lib/jobs/schedulerGuard";
import {
  SCHEDULER_HEARTBEAT_MS,
  SchedulerAlreadyRunningError,
  acquireSchedulerLease,
  heartbeatSchedulerLease,
  releaseSchedulerLease,
  type SchedulerJob,
} from "../src/lib/jobs/schedulerLease";
import {
  dissolvedRefreshDue,
  loadDissolvedRefreshState,
  loadRefreshConfig,
  loadStatusReconcileState,
  runDissolvedRefresh,
  runStatusReconcile,
  statusReconcileDue,
} from "../src/lib/jobs/dissolvedRefresh";
import { db } from "../src/lib/db";
import { makeLogger } from "../src/lib/log";

const logger = makeLogger("scheduler");
const log = (m: string) => logger.info(m);
const argv = process.argv.slice(2);
const ONCE = argv.includes("--once");
const WITH_MONTHLY = argv.includes("--with-monthly");

const num = (name: string, fallback: number) => (Number.isFinite(Number(process.env[name])) && process.env[name]?.trim() !== "" ? Number(process.env[name]) : fallback);
const DAILY_HOUR = num("DAILY_UPDATE_UTC_HOUR", 3);
const MONTHLY_DAY = num("MONTHLY_INGEST_DAY", 3);
const MONTHLY_HOUR = num("MONTHLY_INGEST_UTC_HOUR", 4);
const MONTHLY_ENABLED = process.env.MONTHLY_INGEST_ENABLED === "1";
const OFFICER_WORKER_ENABLED = process.env.OFFICER_WORKER_ENABLED === "1";
const OFFICER_CRAWL_ENABLED = process.env.OFFICER_CRAWL_ENABLED === "1";
const STREAM_ENABLED = process.env.STREAM_WORKER_ENABLED === "1";
const NEW_REG_ENABLED = process.env.NEW_REGISTRATIONS_ENABLED !== "0";
const NEW_REG_INTERVAL_MS = Math.max(1, num("NEW_REGISTRATIONS_INTERVAL_HOURS", 6)) * 3_600_000;
const NEW_REG_RETRY_MS = 15 * 60_000;
const DAILY_RETRY_MS = num("DAILY_RETRY_MINUTES", 30) * 60_000;
const DAILY_MAX_ATTEMPTS = num("DAILY_MAX_ATTEMPTS", 5);
const ONCE_OFFICER_MS = Math.max(1, num("ONCE_OFFICER_MINUTES", 50)) * 60_000;
const SHUTDOWN_GRACE_MS = Math.max(5, num("SCHEDULER_SHUTDOWN_GRACE_SECONDS", 60)) * 1000;
const refreshCfg = loadRefreshConfig();
// Windows cannot deliver SIGTERM to a console process, so a supervisor stops the scheduler GRACEFULLY by creating this file.
const STOP_FILE = process.env.SCHEDULER_STOP_FILE?.trim() || null;

function enabledJobs(): SchedulerJob[] {
  const rest = isRestConfigured();
  const jobs: SchedulerJob[] = [];
  if (NEW_REG_ENABLED && rest) jobs.push("new_registrations");
  if (DAILY_MAX_ATTEMPTS > 0) jobs.push("daily_update");
  if (refreshCfg.dissolvedEnabled && rest) jobs.push("dissolved_refresh");
  if (refreshCfg.statusEnabled && rest && refreshCfg.statuses.length) jobs.push("status_reconcile");
  if (MONTHLY_ENABLED && (!ONCE || WITH_MONTHLY)) jobs.push("monthly_bulk");
  if (OFFICER_WORKER_ENABLED) jobs.push("officer_worker");
  if (STREAM_ENABLED && !ONCE) jobs.push("stream");
  return jobs;
}

const shutdownController = new AbortController();
let shuttingDown = false;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const startOfUtcDay = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

// ---------------------------------------------------------------------------------------------------------------------
// Jobs. Each decides from the DATABASE whether it is due, never throws into the caller, and is safe to call every minute.
// ---------------------------------------------------------------------------------------------------------------------
let newRegNextAttempt = 0;
async function maybeRunNewRegistrations() {
  if (!NEW_REG_ENABLED || !isRestConfigured() || Date.now() < newRegNextAttempt) return;
  const last = await db.ingestionRun.findFirst({ where: { kind: "new_registrations", status: "success" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  if (last && Date.now() - last.startedAt.getTime() < NEW_REG_INTERVAL_MS) return;
  newRegNextAttempt = Date.now() + NEW_REG_RETRY_MS; // only matters if this attempt does not succeed
  try {
    const r = await syncNewRegistrations({ log, signal: shutdownController.signal });
    log(`New registrations: ${r.status}, covered through ${r.coveredThrough ?? "-"}, ${r.rowsInserted} new, ${r.rowsUpdated} refreshed${r.error ? `, error: ${r.error}` : ""}`);
    if (r.status === "success") newRegNextAttempt = 0;
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) log(`New registrations skipped: ${err.message}`);
    else log(`New registrations FAILED; retry in ${NEW_REG_RETRY_MS / 60_000} min: ${errText(err)}`);
  }
}

// Restart-safe: today's attempts are counted from the run table, not from memory.
async function maybeRunDaily(now: Date) {
  if (DAILY_MAX_ATTEMPTS <= 0 || now.getUTCHours() < DAILY_HOUR) return;
  const today = await db.ingestionRun.findMany({ where: { kind: "daily_update", startedAt: { gte: startOfUtcDay(now) } }, select: { status: true, startedAt: true }, orderBy: { startedAt: "desc" } });
  if (today.some((r) => r.status === "success" || r.status === "partial")) return; // done today
  if (today.length >= DAILY_MAX_ATTEMPTS) return;
  if (today[0] && now.getTime() - today[0].startedAt.getTime() < DAILY_RETRY_MS) return;
  log(`Running daily update (attempt ${today.length + 1}/${DAILY_MAX_ATTEMPTS})`);
  try {
    const result = await runDailyUpdate();
    log(`Daily update: ${JSON.stringify(result)}`);
    if (result.reportsFailed > 0) log(`Daily update had ${result.reportsFailed} failed report(s); it is retried while the run is not marked success/partial`);
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) log(`Daily update skipped: ${err.message}`);
    else log(`Daily update FAILED; retry in ${DAILY_RETRY_MS / 60_000} min: ${errText(err)}`);
  }
}

async function maybeRunDissolvedRefresh(now: Date) {
  if (!refreshCfg.dissolvedEnabled || !isRestConfigured()) return;
  if (!dissolvedRefreshDue(await loadDissolvedRefreshState(now), now, refreshCfg)) return;
  try {
    const r = await runDissolvedRefresh({ now, signal: shutdownController.signal, log });
    log(`Dissolved refresh: ${r.status}, ${r.requests} requests, ${r.rowsRead} read, ${r.rowsInserted} new, ${r.rowsUpdated} reconciled${r.error ? `, error: ${r.error}` : ""}${r.failedWindows.length ? `, ${r.failedWindows.length} window(s) not fully read` : ""}`);
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) log(`Dissolved refresh skipped: ${err.message}`);
    else log(`Dissolved refresh FAILED; retry in ${refreshCfg.retryMs / 60_000} min: ${errText(err)}`);
  }
}

async function maybeRunStatusReconcile(now: Date) {
  if (!refreshCfg.statusEnabled || !isRestConfigured()) return;
  for (const status of refreshCfg.statuses) {
    if (shuttingDown) return;
    if (!statusReconcileDue(await loadStatusReconcileState(status, now), now, refreshCfg)) continue;
    try {
      const r = await runStatusReconcile(status, { signal: shutdownController.signal, log });
      log(`Status reconcile (${status}): ${r.status}, ${r.requests} requests, ${r.rowsRead} read, ${r.rowsInserted} new, ${r.rowsUpdated} reconciled${r.error ? `, error: ${r.error}` : ""}`);
    } catch (err) {
      if (err instanceof JobAlreadyRunningError) log(`Status reconcile (${status}) skipped: ${err.message}`);
      else log(`Status reconcile (${status}) FAILED: ${errText(err)}`);
      return; // let the next tick retry; do not hammer the next status while Companies House is failing
    }
  }
}

// Monthly bulk file. Restart-safe and publication-aware: it runs only when the newest PUBLISHED file is newer than the
// snapshot already loaded (read from the run table), so a restart never reloads a file and an unpublished file is simply
// re-checked in an hour. An interrupted load (failed / stalled run with a checkpoint) is RESUMED, not restarted.
let monthlyNextCheck = 0;
async function maybeRunMonthly(now: Date) {
  if (!MONTHLY_ENABLED || (ONCE && !WITH_MONTHLY)) return;
  if (!(now.getUTCDate() >= MONTHLY_DAY && now.getUTCHours() >= MONTHLY_HOUR)) return;
  if (Date.now() < monthlyNextCheck) return;
  monthlyNextCheck = Date.now() + 60 * 60_000;
  try {
    const url = await resolveLatestMonthlyUrl(now);
    const published = snapshotDateFromName(url.split("/").pop() ?? "");
    const lastRun = await db.ingestionRun.findFirst({ where: { kind: "bulk_csv", status: { in: ["success", "partial"] } }, orderBy: { startedAt: "desc" }, select: { statsJson: true, startedAt: true } });
    let loaded: string | null = null;
    try {
      loaded = lastRun?.statsJson ? ((JSON.parse(lastRun.statsJson) as { snapshotDate?: string | null }).snapshotDate ?? null) : null;
    } catch {
      /* unreadable stats: treat as nothing loaded */
    }
    if (published && loaded && published.toISOString().slice(0, 10) <= loaded) return; // already have the newest published file
    const interrupted = await db.ingestionRun.findFirst({
      where: { kind: "bulk_csv", status: "failed", startedAt: { gt: lastRun?.startedAt ?? new Date(0), gte: new Date(now.getTime() - 10 * 86_400_000) } },
      orderBy: { startedAt: "desc" },
      select: { id: true, checkpoint: true },
    });
    log(`Running monthly bulk ingest (published ${published?.toISOString().slice(0, 10) ?? "unknown"}, loaded ${loaded ?? "none"})`);
    const run = (resumeRunId?: string) => bulkIngestFromCsv({ input: url, resumeRunId, log, signal: shutdownController.signal });
    let result;
    if (interrupted && Number(interrupted.checkpoint ?? "0") > 0) {
      try {
        log(`Resuming interrupted monthly run ${interrupted.id} after row ${interrupted.checkpoint}`);
        result = await run(interrupted.id);
      } catch (err) {
        // A different file (a newer month) cannot be resumed into: start fresh. Anything else is a real failure.
        if (!/Refusing to resume|cannot be resumed/.test(errText(err))) throw err;
        log(`Cannot resume ${interrupted.id} (${errText(err)}); starting a fresh monthly load`);
        result = await run();
      }
    } else {
      result = await run();
    }
    log(`Monthly ingest: ${JSON.stringify(result)}`);
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) log(`Monthly ingest skipped: ${err.message}`);
    else log(`Monthly ingest FAILED; re-checked in 1 h (an interrupted load resumes from its checkpoint): ${errText(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Long-lived workers (persistent mode) and the lanes that keep one job type from overlapping itself in this process.
// ---------------------------------------------------------------------------------------------------------------------
let officerNextStart = 0;
const lanes = new Map<string, Promise<void>>();
function launch(name: string, fn: () => Promise<void>) {
  if (shuttingDown || lanes.has(name)) return;
  const p = fn()
    .catch((err) => log(`${name} lane failed: ${errText(err)}`))
    .finally(() => lanes.delete(name));
  lanes.set(name, p);
}

async function officerRun(maxRuntimeMs: number, exitWhenIdle: boolean) {
  try {
    const stats = await runOfficerWorker({ crawl: OFFICER_CRAWL_ENABLED, maxRuntimeMs, exitWhenIdle, signal: shutdownController.signal, log });
    officerNextStart = Date.now() + restartDelayMs(stats.stopReason);
  } catch (err) {
    if (err instanceof JobAlreadyRunningError) {
      officerNextStart = Date.now() + restartDelayMs("already_running");
      log(`Officer worker skipped: ${err.message}`);
    } else {
      officerNextStart = Date.now() + restartDelayMs("error");
      log(`Officer worker failed: ${errText(err)}`);
    }
  }
}

let streamWarned = false;
function ensureStreamWorker() {
  if (!STREAM_ENABLED || ONCE || shuttingDown || lanes.has("stream")) return;
  if (!isStreamConfigured()) {
    if (!streamWarned) log("Stream worker NOT started: COMPANIES_HOUSE_STREAM_KEY is not configured");
    streamWarned = true;
    return;
  }
  // The stream resumes from its stored checkpoint, so a restart after a crash or a Companies House disconnect loses nothing.
  launch("stream", async () => {
    try {
      await runStreamWorker({ signal: shutdownController.signal, onEvent: log });
    } catch (err) {
      log(`Stream worker stopped: ${errText(err)}`);
    }
  });
}

async function tick() {
  if (shuttingDown) return;
  const now = new Date();
  try {
    await reconcileStaleRuns();
  } catch (err) {
    log(`Scheduler housekeeping failed: ${errText(err)}`);
    return; // the database is unreachable: nothing else can work either
  }
  if (OFFICER_WORKER_ENABLED && Date.now() >= officerNextStart) launch("officer", () => officerRun(55 * 60_000, true));
  ensureStreamWorker();
  // Company-data lane: strictly in order so the search-based jobs never compete with each other for quota.
  launch("company-sync", async () => {
    await maybeRunNewRegistrations(); // before the daily update: its report refresh should see the newest companies
    await maybeRunDissolvedRefresh(now);
    await maybeRunStatusReconcile(now);
  });
  launch("daily", () => maybeRunDaily(now));
  launch("monthly", () => maybeRunMonthly(now));
}

// One pass over every due job, then exit. Order matters: quick jobs first, the (bounded) officer run last.
async function runOnce() {
  const now = new Date();
  await reconcileStaleRuns();
  await maybeRunNewRegistrations();
  await maybeRunDaily(now);
  await maybeRunDissolvedRefresh(now);
  await maybeRunStatusReconcile(now);
  await maybeRunMonthly(now);
  if (OFFICER_WORKER_ENABLED && !shuttingDown) await officerRun(ONCE_OFFICER_MS, true);
}

// ---------------------------------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------------------------------
let leaseId: string | null = null;
let jobs: SchedulerJob[] = [];
let heartbeat: NodeJS.Timeout | null = null;
let timer: NodeJS.Timeout | null = null;

async function shutdown(reason: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Scheduler stopping: ${reason}`);
  if (timer) clearInterval(timer);
  if (heartbeat) clearInterval(heartbeat);
  shutdownController.abort();
  // Running jobs see the abort signal, finish their current request/batch and leave their checkpoint in the database.
  await Promise.race([Promise.allSettled([...lanes.values()]), new Promise((r) => setTimeout(r, SHUTDOWN_GRACE_MS))]);
  if (leaseId) await releaseSchedulerLease(leaseId, reason, jobs, code === 0 ? "success" : "failed").catch(() => {});
  await db.$disconnect().catch(() => {});
  process.exit(code);
}

async function main() {
  const guard = evaluateSchedulerDbGuard();
  if (!guard.ok) {
    logger.error(`Scheduler REFUSED to start: ${guard.reason} (connected target: ${guard.target})`);
    process.exit(2);
  }
  jobs = enabledJobs();
  const instance = `${os.hostname()}:${process.pid}`;
  const target = describeDatabaseUrl(process.env.DATABASE_URL);
  try {
    const row = await acquireSchedulerLease(instance, jobs, { mode: ONCE ? "once" : "persistent", dbTarget: guard.target, node: process.version, startedBy: instance });
    leaseId = row.id;
  } catch (err) {
    if (err instanceof SchedulerAlreadyRunningError) {
      logger.warn(`Scheduler not started: ${err.message}`);
      await db.$disconnect().catch(() => {});
      process.exit(3);
    }
    throw err;
  }
  log(
    `Scheduler started (${ONCE ? "one pass" : "persistent"}; database ${target ? `${target.host}:${target.port}/${target.database}` : "?"}; jobs: ${jobs.length ? jobs.join(", ") : "none"}; ` +
      `daily ${DAILY_MAX_ATTEMPTS > 0 ? `${DAILY_HOUR}:00 UTC` : "disabled"}; dissolved refresh ${refreshCfg.dissolvedEnabled ? `${refreshCfg.hourUtc}:00 UTC` : "disabled"}; ` +
      `monthly ${MONTHLY_ENABLED ? `day ${MONTHLY_DAY} ${MONTHLY_HOUR}:00 UTC` : "disabled"}; new registrations ${NEW_REG_ENABLED && isRestConfigured() ? `every ${NEW_REG_INTERVAL_MS / 3_600_000}h` : "disabled"}; ` +
      `officer worker ${OFFICER_WORKER_ENABLED ? (OFFICER_CRAWL_ENABLED ? "on + crawl" : "on, queue only") : "disabled"}; stream ${STREAM_ENABLED ? "on" : "disabled"})`
  );

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    process.on(sig, () => {
      if (shuttingDown) process.exit(0); // a second signal means "now"
      void shutdown(`received ${sig}`);
    });
  }
  heartbeat = setInterval(async () => {
    if (STOP_FILE && fs.existsSync(STOP_FILE)) {
      void shutdown(`stop file ${STOP_FILE} found`);
      return;
    }
    try {
      const hb = await heartbeatSchedulerLease(leaseId!, jobs);
      if (!hb.ok) {
        logger.error(`Scheduler lease lost (${hb.reason}); stopping so only one scheduler owns these jobs`);
        void shutdown("lease lost", 3);
      }
    } catch (err) {
      log(`Scheduler heartbeat failed (database unreachable?): ${errText(err)}`); // transient: keep running, the next beat retries
    }
  }, SCHEDULER_HEARTBEAT_MS);

  if (ONCE) {
    await runOnce();
    await shutdown("one pass finished", 0);
    return;
  }
  void tick();
  timer = setInterval(tick, 60_000);
}

main().catch(async (err) => {
  logger.error(`Scheduler crashed: ${errText(err)}`);
  if (leaseId) await releaseSchedulerLease(leaseId, errText(err), jobs, "failed").catch(() => {});
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
