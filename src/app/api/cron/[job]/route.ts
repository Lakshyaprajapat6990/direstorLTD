import { NextResponse } from "next/server";
import { runDailyUpdate } from "@/lib/companies-house/dailyUpdate";
import { syncNewRegistrations } from "@/lib/companies-house/newRegistrations";
import { runOfficerWorker } from "@/lib/companies-house/officerWorker";
import { isRestConfigured } from "@/lib/companies-house/client";
import { JobAlreadyRunningError, reconcileStaleRuns } from "@/lib/jobs/runs";
import {
  dissolvedRefreshDue,
  loadDissolvedRefreshState,
  loadRefreshConfig,
  loadStatusReconcileState,
  runDissolvedRefresh,
  runStatusReconcile,
  statusReconcileDue,
} from "@/lib/jobs/dissolvedRefresh";
import { makeLogger } from "@/lib/log";

// Background jobs for hosts that cannot run the long-lived scheduler (`npm run jobs:scheduler`), i.e. serverless platforms
// such as Vercel, where nothing stays resident between requests. A platform cron calls these paths on a schedule;
// vercel.json holds the timetable. Each job is the SAME function the scheduler calls, so there is one implementation of the
// work and no second copy of the logic to keep in step.
//
// This is NOT a full replacement for the scheduler:
//   - the Companies House STREAM worker is absent on purpose. It needs one persistent connection per key, which a function
//     that is killed at the end of every request cannot hold. A host that needs the stream needs the real scheduler.
//   - the monthly bulk ingest is absent too: it reads a multi-GB CSV, far past any function time limit.
// Both of those still belong on a machine running `npm run jobs:scheduler`. See docs/PRODUCTION_SCHEDULER.md.
//
// Safety: every job here is restart-safe and takes the same database lock the scheduler takes, so a cron firing while the
// real scheduler (or a previous, still-running invocation) holds the lock is refused by JobAlreadyRunningError and reported
// as "skipped" rather than running the work twice. Running both a scheduler and these crons is therefore safe, if wasteful.

export const dynamic = "force-dynamic";
export const maxDuration = 300; // the ceiling; each job below also stops itself well before the platform's limit

const logger = makeLogger("cron");
// The jobs take a plain line-logger; makeLogger gives a structured one, so route their lines through its info level.
const log = (message: string) => logger.info(message);

// Jobs the scheduler decides by clock time are called unconditionally here: the cron timetable IS the schedule. The jobs that
// track their own due-date in the database keep being asked, so a missed window is picked up by the next call.
const JOBS = {
  // Companies House daily delta. Restart-safe; counts its own attempts per UTC day.
  "daily-update": async () => {
    if (!isRestConfigured()) return { skipped: "COMPANIES_HOUSE_API_KEY is not set" };
    return runDailyUpdate();
  },

  // Newly incorporated companies.
  "new-registrations": async () => {
    if (!isRestConfigured()) return { skipped: "COMPANIES_HOUSE_API_KEY is not set" };
    return syncNewRegistrations({ log });
  },

  // Dissolved-company refresh plus the weekly status reconcile, each only when the database says it is due.
  "dissolved-refresh": async () => {
    if (!isRestConfigured()) return { skipped: "COMPANIES_HOUSE_API_KEY is not set" };
    const cfg = loadRefreshConfig();
    const now = new Date();
    const out: Record<string, unknown> = {};

    if (cfg.dissolvedEnabled && dissolvedRefreshDue(await loadDissolvedRefreshState(now), now, cfg)) {
      out.dissolved = await runDissolvedRefresh({ now, log });
    } else {
      out.dissolved = { skipped: cfg.dissolvedEnabled ? "not due yet" : "DISSOLVED_REFRESH_ENABLED is not 1" };
    }

    if (cfg.statusEnabled) {
      const statuses: Record<string, unknown> = {};
      for (const status of cfg.statuses) {
        if (!statusReconcileDue(await loadStatusReconcileState(status, now), now, cfg)) {
          statuses[status] = { skipped: "not due yet" };
          continue;
        }
        try {
          statuses[status] = await runStatusReconcile(status, { log });
        } catch (err) {
          // Do not hammer the next status while Companies House is failing; the next cron call retries.
          statuses[status] = { error: err instanceof Error ? err.message : String(err) };
          break;
        }
      }
      out.statusReconcile = statuses;
    }
    return out;
  },

  // Officer coverage queue. Bounded by time so the function returns before the platform kills it: whatever is left stays
  // queued for the next call. exitWhenIdle stops it burning the budget waiting for work that is not there.
  "officer-worker": async () => {
    if (!isRestConfigured()) return { skipped: "COMPANIES_HOUSE_API_KEY is not set" };
    return runOfficerWorker({
      maxRuntimeMs: 4 * 60_000,
      exitWhenIdle: true,
      crawl: process.env.OFFICER_CRAWL_ENABLED === "1",
      log,
    });
  },

  // Housekeeping: marks jobs whose worker died (a function killed mid-run leaves a "running" row) as failed, so the health
  // endpoint and the staff dashboard do not report a dead job as live for ever. Cheap; run it often.
  reconcile: async () => ({ reconciled: await reconcileStaleRuns() }),
} satisfies Record<string, () => Promise<unknown>>;

type JobName = keyof typeof JOBS;
const isJobName = (v: string): v is JobName => Object.hasOwn(JOBS, v);

// Vercel signs its cron calls with CRON_SECRET as a bearer token; it sets that header itself and never exposes the path.
// Anything else (including a browser hitting the URL) is refused, so these jobs can never be triggered by an outsider.
// Without CRON_SECRET set the endpoint refuses everything: an unauthenticated job runner is worse than none.
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

export async function GET(request: Request, { params }: { params: Promise<{ job: string }> }) {
  const { job } = await params;

  if (!authorized(request)) {
    // Deliberately identical for a bad secret and an unknown job: an outsider learns nothing about which jobs exist.
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (!isJobName(job)) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const started = Date.now();
  try {
    const result = await JOBS[job]();
    const ms = Date.now() - started;
    log(`${job} finished in ${ms} ms: ${JSON.stringify(result)}`);
    return NextResponse.json({ ok: true, job, ms, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const ms = Date.now() - started;
    // Another worker holds the lock: that is the expected outcome, not a failure, so cron does not alert on it.
    if (err instanceof JobAlreadyRunningError) {
      log(`${job} skipped: ${err.message}`);
      return NextResponse.json({ ok: true, job, ms, skipped: err.message }, { headers: { "Cache-Control": "no-store" } });
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`${job} FAILED after ${ms} ms: ${message}`);
    // 500 so the platform's cron log and any uptime monitor show the failure.
    return NextResponse.json({ ok: false, job, ms, error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
