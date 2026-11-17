import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { latestRecordedCap, type RecordDay } from "./director-progress-calc";
import { buildDirectorSummaryView, type DirectorSummaryView } from "./director-summary-view";
import { currentEstimate } from "./director-progress";

// The figures of the Director Data card and its modal:
//   1. DIRECTOR DATA IMPORTED: an ACTUAL count of the director + LLP-member appointment records stored in the Director table (secretaries and
//      other officers excluded), across every company status, dissolved included. CURRENT = no resignation date in a company that is not
//      dissolved; HISTORICAL = resigned, or an appointment of a dissolved company. Counted from the rows themselves.
//      ESTIMATED TOTAL = that actual count + the ESTIMATE for the companies not yet checked (director-progress.ts: stratified by status, type,
//      age and dissolution year). The two are kept apart: the first is a count, the second is always an estimate.
//   2. LAST SUCCESSFUL UPDATE: the newest officersFetchedAt of a company whose officer data was fetched or confirmed unavailable. The database's
//      own timestamp, not the page-load time.
//   3. DAILY COMPANIES HOUSE API REQUESTS: today's (UTC) requests from the SHARED request ledger (ChRequestStat: every request any job sent,
//      not just the officer worker's own tally), against the daily request cap the officer worker recorded for its runs.
// The pure part (this file, below) turns those inputs into text; the database part follows. No other processing statistic is read.

export type { DirectorSummaryView, DirectorSummaryInput } from "./director-summary-view";
export { buildDirectorSummaryView } from "./director-summary-view";

// ---------------------------------------------------------------------------------------------------------------------------------
// Database side. Three cheap reads (the newest check, today's ledger total, the recorded cap) cached for 30 s; the estimate has its own
// longer-lived store (director-progress.ts) and is attached to whatever is served, so a finished calculation reaches the very next view.
// ---------------------------------------------------------------------------------------------------------------------------------
interface Base {
  imported: { current: number; historical: number } | null;
  importedToday: number | null; // director / LLP-member records inserted since 00:00 UTC (actual rows; see readBase)
  recordDaily: RecordDay[]; // director / LLP-member rows inserted per UTC day (the last 14 days)
  firstRecordDay: string | null; // the first UTC day with an import: how long the history is
  lastUpdateAt: Date | null;
  requestsToday: number | null;
  cap: number | null;
  at: number;
}
const store = globalThis as unknown as { __directorSummary?: { base: Base | null; inflight: Promise<Base> | null } };
const state = (store.__directorSummary ??= { base: null, inflight: null });

async function readBase(now: Date): Promise<Base> {
  const dayStart = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const { DIRECTOR_ROLES, LLP_MEMBER_ROLES } = await import("@/lib/companies-house/officers");
  const roles = Prisma.join([...DIRECTOR_ROLES, ...LLP_MEMBER_ROLES]);
  const since = new Date(dayStart.getTime() - 14 * 86_400_000);
  const [last, ledger, runs, imported, recordDaily, firstRecordDay, importedToday] = await Promise.all([
    db.company.aggregate({ where: { source: { not: "seed" }, officersCoverage: { in: ["full", "unavailable"] } }, _max: { officersFetchedAt: true } }),
    db.chRequestStat.aggregate({ where: { bucketStart: { gte: dayStart } }, _sum: { requests: true } }).then((r) => r._sum.requests ?? 0, () => null),
    db.ingestionRun.findMany({ where: { kind: "officer_backfill" }, orderBy: { startedAt: "desc" }, take: 5, select: { statsJson: true } }),
    db
      .$queryRaw<{ cur: bigint; hist: bigint }[]>(Prisma.sql`
        SELECT count(*) FILTER (WHERE d."resignedOn" IS NULL AND c."status" <> 'dissolved') AS cur,
               count(*) FILTER (WHERE d."resignedOn" IS NOT NULL OR c."status" = 'dissolved') AS hist
          FROM "Director" d JOIN "Company" c ON c."id" = d."companyId"
         WHERE d."role" IN (${roles}) AND c."source" <> 'seed'`)
      .then((r) => ({ current: Number(r[0]?.cur ?? 0), historical: Number(r[0]?.hist ?? 0) }), () => null),
    // Records imported per UTC day (the basis of the time-to-complete estimate): the same rows as "imported today", grouped by the day they were inserted.
    // createdAt is a timestamp WITHOUT time zone that holds UTC, so it is formatted as it is (AT TIME ZONE would shift the days by the server offset).
    db
      .$queryRaw<{ d: string; n: bigint }[]>(Prisma.sql`
        SELECT to_char(d."createdAt", 'YYYY-MM-DD') AS d, count(*) AS n
          FROM "Director" d JOIN "Company" c ON c."id" = d."companyId"
         WHERE d."createdAt" >= ${since.toISOString()}::timestamp AND d."role" IN (${roles}) AND c."source" <> 'seed'
         GROUP BY 1`)
      .then((r) => r.map((x) => ({ day: x.d, records: Number(x.n) })), () => [] as RecordDay[]),
    db
      .$queryRaw<{ d: string | null }[]>(Prisma.sql`SELECT to_char(min("createdAt"), 'YYYY-MM-DD') AS d FROM "Director" WHERE "source" <> 'seed'`)
      .then((r) => r[0]?.d ?? null, () => null),
    // Records imported today: the Director rows inserted since 00:00 UTC (createdAt is set when a row is inserted) in director / LLP-member roles.
    // A company's rows are inserted when its officers are fetched for the first time; the worker never re-fetches a checked company inside the
    // freshness window (OFFICER_STALE_AFTER_DAYS, 180); verified on the real database: no freshness re-fetch enqueued, no company flagged dirty, no company with rows inserted twice.
    db
      .$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT count(*) AS n FROM "Director" d JOIN "Company" c ON c."id" = d."companyId"
         WHERE d."createdAt" >= ${dayStart.toISOString()}::timestamp AND d."role" IN (${roles}) AND c."source" <> 'seed'`)
      .then((r) => Number(r[0]?.n ?? 0), () => null),
  ]);
  return { imported, importedToday, recordDaily, firstRecordDay, lastUpdateAt: last._max.officersFetchedAt, requestsToday: ledger, cap: latestRecordedCap([...runs].reverse()), at: Date.now() };
}

export async function getDirectorDataSummary(options: { now?: Date; ttlMs?: number; waitForEstimate?: boolean } = {}): Promise<DirectorSummaryView> {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? new Date();
  const fresh = state.base && Date.now() - state.base.at < ttlMs;
  if (!fresh) {
    state.inflight ??= readBase(now)
      .then((b) => (state.base = b))
      .finally(() => {
        state.inflight = null;
      });
    // A read that is only a little old is served while the next one is fetched in the background; one older than twice the cache time (a page
    // opened after a quiet spell) is never shown: the figures are read again first, so a view is never more than ~1 minute behind the database.
    const tooOld = !state.base || Date.now() - state.base.at > ttlMs * 2;
    if (tooOld || ttlMs === 0) await state.inflight;
    else void state.inflight.catch(() => {});
  }
  const [base, est] = await Promise.all([Promise.resolve(state.base as Base), currentEstimate(options.waitForEstimate === true)]);
  return buildDirectorSummaryView({
    now,
    asOf: new Date(base.at), // the time the figures were READ (the "Figures as of" line), not the time of the request
    imported: base.imported,
    importedToday: base.importedToday,
    recordHistory: { daily: base.recordDaily, firstDay: base.firstRecordDay },
    estimate: est.estimate, estimateStatus: est.status, lastUpdateAt: base.lastUpdateAt, requestsToday: base.requestsToday, cap: base.cap });
}
