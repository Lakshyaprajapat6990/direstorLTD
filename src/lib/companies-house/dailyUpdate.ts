import { db } from "@/lib/db";
import { buildCompanyWhere } from "@/lib/data/companies";
import { isRestConfigured } from "./client";
import { reconcilePendingFilingEvents } from "./filingEvents";
import { enqueueTrackedCompanies, loadOfficerConfig } from "./officerQueue";
import { enqueueReportOfficers, ownerCanSeeDirectors } from "./officerTriggers";
import { finishRun, reconcileStaleRuns, startRun, touchRun } from "@/lib/jobs/runs";

export interface DailyUpdateOptions {
  // Max companies one report / the followed list may add to the officer queue
  // per run (default OFFICER_ENQUEUE_CAP). 0 disables the orchestration step.
  officerEnqueueCap?: number;
}

export interface DailyUpdateResult {
  staleRunsClosed: number;
  overdueRecomputed: number;
  pendingEventsApplied: number;
  pendingEventsRemaining: number;
  officersQueuedForReports: number;
  officersQueuedForFollowed: number;
  reportsRefreshed: number;
  reportsFailed: number;
}

function utcToday(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

// The scheduled daily job (see README for the AWS shape). Safe to run more
// than once a day. Steps:
//   0. close dead "running" jobs
//   1. recompute overdue flags from stored due dates (both directions)
//   2. apply any DS01/DS02 stream events that could not be applied earlier
//   3. QUEUE officer work for saved director reports (P1) and followed
//      companies (P2). This is orchestration only - a few SQL statements, no
//      Companies House calls. All officer fetching belongs to the dedicated
//      officer worker (npm run ch:officer-worker).
//   4. refresh every report flagged dailyRefresh
// It does NOT re-download company profiles: the monthly bulk file is the
// refresh for profile data, the stream covers DS01 in near real time.
export async function runDailyUpdate(options: DailyUpdateOptions = {}): Promise<DailyUpdateResult> {
  const enqueueCap = options.officerEnqueueCap ?? loadOfficerConfig().enqueueCap;
  const run = await startRun("daily_update");
  // The parent run heartbeats on a timer, so a slow step can never make it
  // look dead to the stale-run reconciliation.
  const heartbeat = setInterval(() => void touchRun(run.id).catch(() => {}), 30_000);
  heartbeat.unref?.();

  const result: DailyUpdateResult = {
    staleRunsClosed: 0,
    overdueRecomputed: 0,
    pendingEventsApplied: 0,
    pendingEventsRemaining: 0,
    officersQueuedForReports: 0,
    officersQueuedForFollowed: 0,
    reportsRefreshed: 0,
    reportsFailed: 0,
  };

  try {
    result.staleRunsClosed = await reconcileStaleRuns();

    // 1. Overdue flags. A company is late only while it is live (active) and
    // its due date has passed; the flag clears again once the date moves on.
    const today = utcToday();
    // On a 14M-row table one UPDATE per flag runs for hours and locks rows the website and other jobs need (four of them in
    // parallel also block each other). So: one flag at a time, in small batches, each its own short transaction.
    const BATCH = 5000;
    const batched = async (setSql: string, whereSql: string) => {
      let total = 0;
      for (;;) {
        const n = await db.$executeRawUnsafe(
          `update "Company" set ${setSql}, "updatedAt" = now()
           where ctid in (select ctid from "Company" where ${whereSql} limit ${BATCH})`,
          today,
        );
        total += n;
        if (n < BATCH) return total;
      }
    };
    const active = `"status"::text = 'active'`;
    const counts = [
      await batched(`"accountsOverdue" = true`, `${active} and "accountsNextDue" < $1 and "accountsOverdue" = false`),
      await batched(`"accountsOverdue" = false`, `"accountsOverdue" = true and (not ${active} or "accountsNextDue" is null or "accountsNextDue" >= $1)`),
      await batched(`"confirmationOverdue" = true`, `${active} and "confirmationNextDue" < $1 and "confirmationOverdue" = false`),
      await batched(`"confirmationOverdue" = false`, `"confirmationOverdue" = true and (not ${active} or "confirmationNextDue" is null or "confirmationNextDue" >= $1)`),
    ];
    result.overdueRecomputed = counts.reduce((s, c) => s + c, 0);
    await touchRun(run.id);

    // 2. Pending DS01/DS02 events.
    if (isRestConfigured()) {
      const rec = await reconcilePendingFilingEvents().catch(() => ({ applied: 0, stillPending: 0 }));
      result.pendingEventsApplied = rec.applied;
      result.pendingEventsRemaining = rec.stillPending;
    }

    // 3. Queue officer work (no API calls here). Reports first (P1), then
    // followed companies (P2). Idempotent: re-running never duplicates jobs and
    // keeps the highest priority.
    if (enqueueCap > 0) {
      // Every daily-refresh report (not only those with a director rule): the people reading it see its companies' directors.
      // Each owner's permission is checked once; priority REPORT, capped, active companies first.
      const reports = await db.report.findMany({ where: { dailyRefresh: true } });
      const ownerOk = new Map<string, boolean>();
      for (const report of reports) {
        try {
          if (!ownerOk.has(report.ownerId)) ownerOk.set(report.ownerId, await ownerCanSeeDirectors(report.ownerId));
          if (!ownerOk.get(report.ownerId)) continue;
          const queued = await enqueueReportOfficers(report, { cap: enqueueCap, ownerChecked: true });
          result.officersQueuedForReports += queued.queued;
        } catch {
          /* a broken report must not stop the daily job; the refresh step below records its error */
        }
      }
      result.officersQueuedForFollowed = (await enqueueTrackedCompanies(enqueueCap)).inserted;
      await touchRun(run.id);
    }

    // 4. Report refresh (counts only what the user is allowed to see - the
    // same scope rules as the live search).
    const reports = await db.report.findMany({ where: { dailyRefresh: true } });
    for (const report of reports) {
      try {
        const resultCount = await db.company.count({ where: buildCompanyWhere({ filter: JSON.parse(report.filterJson), userId: report.ownerId }) });
        const now = new Date();
        // lastAutoRefreshAt is written HERE and nowhere else, and only after the count succeeded: it is the one field that
        // means "the scheduled job refreshed this report". A failure (below) records the error and leaves both timestamps alone.
        await db.report.update({ where: { id: report.id }, data: { resultCount, lastRunAt: now, lastAutoRefreshAt: now, lastRefreshError: null } });
        result.reportsRefreshed++;
      } catch (err) {
        result.reportsFailed++;
        await db.report.update({
          where: { id: report.id },
          data: { lastRefreshError: err instanceof Error ? err.message.slice(0, 500) : String(err) },
        });
      }
    }

    const failed = result.reportsFailed;
    const total = result.reportsRefreshed + failed;
    await finishRun(run.id, failed === 0 ? "success" : failed / Math.max(total, 1) > 0.5 ? "failed" : "partial", {
      rowsRead: total,
      rowsProcessed: result.overdueRecomputed + result.reportsRefreshed + result.pendingEventsApplied,
      rowsFailed: failed,
      statsJson: JSON.stringify(result),
    });
    return result;
  } catch (err) {
    await finishRun(run.id, "failed", { errorMessage: err instanceof Error ? err.message : String(err), statsJson: JSON.stringify(result) });
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}
