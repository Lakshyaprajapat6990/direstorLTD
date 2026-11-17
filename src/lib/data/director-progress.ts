import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { NON_UK_COMPANY_TYPES } from "@/lib/companies-house/eligibility";
import {
  HISTORY_LOOKBACK_DAYS,
  aggregateRuns,
  computeDirectorProgress,
  estimateAppointmentSplit,
  latestRecordedCap,
  stopReasonOf,
  utcDay,
  type AppointmentEstimate,
  type DissolvedSampleStratum,
  type SplitStratum,
  type DirectorProgress,
  type EstimateStatus,
} from "./director-progress-calc";

// Database side of the Director Data progress panel: reads the existing Company, OfficerSyncJob and IngestionRun rows and hands them to the
// pure calculator in director-progress-calc.ts, where every number is defined and explained. Nothing is stored, nothing is simulated.
export * from "./director-progress-calc";

const DAY_MS = 86_400_000;

// ONE SNAPSHOT. The worker is writing while this runs (about a hundred companies a minute), so figures read by separate queries at separate
// moments would not add up (eligible - checked != remaining, "today" ahead of "checked"). Everything below therefore runs in a single
// REPEATABLE READ transaction, and the company figures come from ONE statement over ONE scan.
//
// THE POPULATION is every real (not seed) company of EVERY status: active, dissolved, liquidation, administration, receivership, converted-
// closed, voluntary arrangement, insolvency proceedings, closed. This is exactly what the officer worker's crawl now visits (officerQueue.
// crawlPage: a live lane for active then other live statuses, and a dissolved lane), so "eligible" is counted from the rows and carries no
// other condition. (The register only ever stores UK companies, eligibility.ts, so in production this is the UK register.)
//   * CHECKED = coverage "full" (every officer page fetched) or "unavailable" (Companies House has no officer data for it). Never a guess.
//   * Of the checked: WITH DIRECTORS = fetched and at least one director / LLP-member record (current or historical) is on file; NO DIRECTORS =
//     fetched and Companies House confirmed an officer list without one; UNAVAILABLE = no officer data at Companies House.
//   * CONFIRMED (the dashboard card) = checked with director records, UK company types, any status. Coverage = confirmed / all UK companies.
// The integration tests compare every figure with Prisma counts and with the crawl's own predicate, so none of them can drift.
async function readSnapshot(now: Date) {
  // The roles behind directorCount live next to the Companies House client, which reads its endpoint settings when it is first imported:
  // load it when the figures are first needed, not when this module is loaded.
  const { DIRECTOR_ROLES, LLP_MEMBER_ROLES } = await import("@/lib/companies-house/officers");
  const nonUk = Prisma.join([...NON_UK_COMPANY_TYPES]);
  const roles = Prisma.join([...DIRECTOR_ROLES, ...LLP_MEMBER_ROLES]);
  const todayStart = new Date(`${utcDay(now)}T00:00:00.000Z`);
  const since = new Date(todayStart.getTime() - HISTORY_LOOKBACK_DAYS * DAY_MS);
  return db.$transaction(
    async (tx) => {
      type Counts = Record<string, bigint> & { last_checked: Date | null };
      const [counts] = await tx.$queryRaw<Counts[]>(Prisma.sql`
        SELECT count(*) AS eligible,
               count(*) FILTER (WHERE c."type" NOT IN (${nonUk})) AS total_uk,
               count(*) FILTER (WHERE c."status" = 'active') AS active_total,
               count(*) FILTER (WHERE c."status" = 'dissolved') AS dissolved_total,
               count(*) FILTER (WHERE c."status" NOT IN ('active', 'dissolved')) AS other_total,
               count(*) FILTER (WHERE c."officersCoverage" IN ('full', 'unavailable')) AS checked,
               count(*) FILTER (WHERE c."status" = 'active' AND c."officersCoverage" IN ('full', 'unavailable')) AS active_checked,
               count(*) FILTER (WHERE c."status" = 'dissolved' AND c."officersCoverage" IN ('full', 'unavailable')) AS dissolved_checked,
               count(*) FILTER (WHERE c."status" NOT IN ('active', 'dissolved') AND c."officersCoverage" IN ('full', 'unavailable')) AS other_checked,
               count(*) FILTER (WHERE c."officersCoverage" = 'unavailable') AS unavailable,
               count(*) FILTER (WHERE c."officersCoverage" IN ('full', 'unavailable') AND c."officersFetchedAt" >= ${todayStart.toISOString()}::timestamp) AS today,
               max(c."officersFetchedAt") FILTER (WHERE c."officersCoverage" IN ('full', 'unavailable')) AS last_checked
          FROM "Company" c
         WHERE c."source" <> 'seed'`);
      // Of the companies whose officers were fetched ("full"; about half a million of the register): those with at least one director /
      // LLP-member record on file, current or historical. Evaluated only for those rows, in the same snapshot as everything else.
      const [conf] = await tx.$queryRaw<Record<string, bigint>[]>(Prisma.sql`
        SELECT count(*) AS with_directors,
               count(*) FILTER (WHERE c."type" NOT IN (${nonUk})) AS confirmed_all,
               count(*) FILTER (WHERE c."type" NOT IN (${nonUk}) AND c."status" <> 'dissolved') AS confirmed_eligible
          FROM "Company" c
         WHERE c."source" <> 'seed' AND c."officersCoverage" = 'full'
           AND (c."directorCount" > 0 OR EXISTS (SELECT 1 FROM "Director" d WHERE d."companyId" = c."id" AND d."role" IN (${roles})))`);
      // Unchecked companies whose queue job is waiting for a retry, or gave up (parked): part of "remaining", reported separately.
      const jobs = await tx.$queryRaw<{ status: string; n: bigint }[]>(Prisma.sql`
        SELECT j."status", count(*) AS n
          FROM "OfficerSyncJob" j JOIN "Company" c ON c."id" = j."companyId"
         WHERE j."status" IN ('retry', 'parked') AND c."officersCoverage" = 'none' AND c."source" <> 'seed'
         GROUP BY j."status"`);
      // ACTUAL director appointment records written since 00:00 UTC: Director rows whose createdAt (set when the row is inserted; a company's
      // rows are replaced as a set each time its officer list is fetched) falls in today and whose role is a director or LLP-member role (the
      // definition behind directorCount; secretaries and other officers are never counted). CURRENT = no resignation date AND the company is
      // not dissolved; HISTORICAL = resigned, or an appointment of a dissolved company. Counted from the rows themselves, never as companies x
      // an average. A re-fetch of an already-checked company writes its rows again.
      const [appts] = await tx.$queryRaw<{ cur: bigint; hist: bigint }[]>(Prisma.sql`
        SELECT count(*) FILTER (WHERE d."resignedOn" IS NULL AND c."status" <> 'dissolved') AS cur,
               count(*) FILTER (WHERE d."resignedOn" IS NOT NULL OR c."status" = 'dissolved') AS hist
          FROM "Director" d JOIN "Company" c ON c."id" = d."companyId"
         WHERE d."createdAt" >= ${todayStart.toISOString()}::timestamp AND d."role" IN (${roles}) AND c."source" <> 'seed'`);
      const runs = await tx.ingestionRun.findMany({
        where: { kind: "officer_backfill", startedAt: { gte: since } },
        select: { startedAt: true, statsJson: true },
        orderBy: { startedAt: "asc" },
        take: 5000,
      });
      const latest = await tx.ingestionRun.findFirst({ where: { kind: "officer_backfill" }, orderBy: { startedAt: "desc" }, select: { status: true, heartbeatAt: true, finishedAt: true, statsJson: true } });
      return { counts: { ...counts, ...conf } as Counts, jobs, runs, latest, apptsToday: Number(appts?.cur ?? 0), apptsTodayHistorical: Number(appts?.hist ?? 0) };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 15_000, timeout: 120_000 }
  );
}

// ESTIMATED REMAINING DIRECTOR APPOINTMENTS. One grouped statement over the eligible companies (many seconds on the full register), so it is
// kept in its OWN store, separate from the panel's one-minute snapshot, and is attached to whatever snapshot is served at the moment of the
// request. It is therefore never frozen into an older snapshot, and a finished calculation reaches the very next page view.
//   ready        a value exists (it carries the time it was calculated; kept up to 24 h if a refresh fails)
//   calculating  the first calculation is running right now
//   unavailable  the calculation failed or there are too few checked companies to sample (retried after a minute, never "calculating" forever)
// The store lives on globalThis: in development (and wherever the module is loaded twice) separate copies of module variables would each
// start the calculation and each discard the result.
const ESTIMATE_TTL_MS = 15 * 60_000;
const ESTIMATE_RETRY_MS = 60_000;
const ESTIMATE_KEEP_MS = 24 * 3_600_000;
const TOTALS_TTL_MS = 60 * 60_000;
interface EstimateStore {
  value: AppointmentEstimate | null; // last good estimate
  at: number; // when the last attempt finished (Date.now())
  failed: boolean; // the last attempt threw or had nothing to sample
  inflight: Promise<void> | null;
  version: string | null; // the state of the dissolved random sample this estimate was calculated from (see sampleVersion)
  // Company counts per stratum (every status, checked or not). Grouping 14 million rows is the expensive part of the estimate and these counts
  // move by a few thousand a day, so they are kept for an hour; the SAMPLE (the ~0.5M checked companies) is read fresh on every calculation and
  // the unchecked population of a stratum is its (cached) total minus its (fresh) checked companies.
  totals: { at: number; rows: Map<string, Record<string, unknown> & { total: number }> } | null;
  computer: ((now: Date) => Promise<AppointmentEstimate | null>) | null; // test hook only
}
const globalStore = globalThis as unknown as { __directorEstimate?: EstimateStore };
const estimateStore: EstimateStore = (globalStore.__directorEstimate ??= { value: null, at: 0, failed: false, inflight: null, version: null, computer: null, totals: null });

/** Test hooks: replace the calculation, or forget everything. Not used by the application. */
export function __setAppointmentEstimateComputer(fn: EstimateStore["computer"]) {
  estimateStore.computer = fn;
}
export function __resetAppointmentEstimate() {
  Object.assign(estimateStore, { value: null, at: 0, failed: false, inflight: null, version: null, computer: null, totals: null });
}

/** Resolved members of the dissolved random sample per dissolution-year stratum: count, sum and sum of squares of their records. */
export async function loadSampleStrata(): Promise<DissolvedSampleStratum[]> {
  const rows = await db.$queryRaw<{ year: number; n: bigint; s: bigint | null; ss: bigint | null }[]>(Prisma.sql`
    SELECT "stratum" AS year, count(*) AS n, sum("records") AS s, sum("records" * "records") AS ss
      FROM "DissolvedSample" WHERE "status" IN ('fetched', 'unavailable', 'already_checked') AND "records" IS NOT NULL GROUP BY 1`);
  return rows.map((r) => ({ year: Number(r.year), n: Number(r.n), sum: Number(r.s ?? 0), sumSq: Number(r.ss ?? 0) }));
}

export async function computeAppointmentEstimate(now: Date = new Date()): Promise<AppointmentEstimate | null> {
  const { DIRECTOR_ROLES, LLP_MEMBER_ROLES } = await import("@/lib/companies-house/officers");
  const roles = Prisma.join([...DIRECTOR_ROLES, ...LLP_MEMBER_ROLES]);
  // One grouped statement over the WHOLE register. Strata: status group (active / dissolved / other), company type, incorporation year (pre-1990
  // pooled), dormant flag and, for dissolved companies, dissolution year (2009 = before 2010 or unknown). The sample is every company whose
  // officer data has been fetched OR confirmed unavailable (an unavailable one genuinely has 0 appointments on file); the population is every
  // unchecked company. Each company's appointment count comes from its Director rows: ALL = every director / LLP-member record, CUR = those with
  // no resignation date in a company that is not dissolved, HIST = the rest.
  const STRATA = Prisma.sql`
    CASE WHEN c."status" = 'active' THEN 'active' WHEN c."status" = 'dissolved' THEN 'dissolved' ELSE 'other' END AS sg,
    CASE WHEN c."type" IN ('ltd','private-limited-guarant-nsc','llp','plc','private-unlimited','limited-partnership','community-interest-company','charitable-incorporated-organisation','private-limited-guarant-nsc-limited-exemption')
         THEN c."type" ELSE 'othertype' END AS ty,
    CASE WHEN extract(year FROM c."incorporationDate") < 1990 THEN 1989 ELSE extract(year FROM c."incorporationDate")::int END AS yr,
    c."dormant" AS dm,
    CASE WHEN c."status" = 'dissolved' THEN GREATEST(2009, coalesce(extract(year FROM c."dissolutionDate")::int, 2009)) ELSE 0 END AS dy`;
  type Key = { sg: string; ty: string; yr: number; dm: boolean; dy: number };
  // (1) every company by stratum (cached for an hour, see EstimateStore.totals)
  let totals = estimateStore.totals && Date.now() - estimateStore.totals.at < TOTALS_TTL_MS ? estimateStore.totals.rows : null;
  if (!totals) {
    const all = await db.$queryRaw<(Key & { u: bigint })[]>(Prisma.sql`
      SELECT ${STRATA}, count(*) AS u FROM "Company" c WHERE c."source" <> 'seed' GROUP BY 1, 2, 3, 4, 5`);
    totals = new Map(all.map((r) => [[r.sg, r.ty, r.yr, r.dm, r.dy].join("|"), { ...r, total: Number(r.u) }]));
    estimateStore.totals = { at: Date.now(), rows: totals };
  }
  // (2) the sample: only the companies whose officers were fetched or confirmed unavailable (about half a million), each with its own
  // appointment counts straight from its Director rows (an "unavailable" company has no rows: 0).
  const checked = await db.$queryRaw<(Key & Record<"n" | "s_cur" | "ss_cur" | "s_hist" | "ss_hist" | "s_all" | "ss_all", bigint | null>)[]>(Prisma.sql`
    WITH x AS (
      SELECT "companyId", count(*) AS a, count(*) FILTER (WHERE "resignedOn" IS NULL) AS cur FROM "Director" WHERE "role" IN (${roles}) GROUP BY "companyId"
    ), per AS (
      SELECT ${STRATA},
             coalesce(x.a, 0)::bigint AS a_all,
             CASE WHEN c."status" = 'dissolved' THEN 0 ELSE coalesce(x.cur, 0) END::bigint AS a_cur
        FROM "Company" c LEFT JOIN x ON x."companyId" = c."id"
       WHERE c."source" <> 'seed' AND c."officersCoverage" IN ('full', 'unavailable')
    )
    SELECT sg, ty, yr, dm, dy,
           count(*) AS n,
           sum(a_cur) AS s_cur, sum(a_cur * a_cur) AS ss_cur,
           sum(a_all - a_cur) AS s_hist, sum((a_all - a_cur) * (a_all - a_cur)) AS ss_hist,
           sum(a_all) AS s_all, sum(a_all * a_all) AS ss_all
      FROM per GROUP BY 1, 2, 3, 4, 5`);
  const z = (v: bigint | null | undefined) => Number(v ?? 0);
  const k = (r: Key) => [r.sg, r.ty, r.yr, r.dm, r.dy].join("|");
  const map = new Map<string, SplitStratum>();
  const get = (r: Key) => {
    const key = k(r);
    let x = map.get(key);
    if (!x) map.set(key, (x = { sg: r.sg, ty: r.ty, yr: r.yr, dm: r.dm, dy: r.dy, n: 0, u: 0, v: { cur: { s: 0, ss: 0 }, hist: { s: 0, ss: 0 }, all: { s: 0, ss: 0 } } }));
    return x;
  };
  for (const t of totals.values()) get(t as unknown as Key).u = t.total;
  for (const r of checked) {
    const x = get(r);
    x.n += z(r.n);
    x.u = Math.max(0, x.u - z(r.n)); // the unchecked part of a stratum: its total minus the companies checked in it
    x.v = { cur: { s: z(r.s_cur), ss: z(r.ss_cur) }, hist: { s: z(r.s_hist), ss: z(r.ss_hist) }, all: { s: z(r.s_all), ss: z(r.ss_all) } };
  }
  const strata: SplitStratum[] = [...map.values()];
  return estimateAppointmentSplit(strata, now, await loadSampleStrata());
}

/** A cheap fingerprint of the resolved dissolved random sample (how many members, and when the newest was fetched). */
async function sampleVersion(): Promise<string> {
  try {
    const r = await db.$queryRaw<{ v: string }[]>`SELECT count(*)::text || ':' || coalesce(max("fetchedAt")::text, '') AS v FROM "DissolvedSample" WHERE "status" IN ('fetched', 'unavailable', 'already_checked')`;
    return r[0]?.v ?? "";
  } catch {
    return "";
  }
}

function startEstimate(): Promise<void> {
  // The calculation starts at once; the sample fingerprint is read alongside it and always BEFORE the calculation reads the sample, so a sample that
  // changes meanwhile leaves an older fingerprint behind and the next view recalculates (never the other way round).
  const calc = async () => {
    const [version, value] = await Promise.all([sampleVersion(), (estimateStore.computer ?? computeAppointmentEstimate)(new Date())]);
    return { value, version };
  };
  estimateStore.inflight ??= calc()
    .then(({ value, version }) => {
      estimateStore.version = version;
      estimateStore.at = Date.now();
      estimateStore.failed = value === null;
      if (value) estimateStore.value = value;
    })
    .catch((err) => {
      console.error("director appointment estimate failed:", err instanceof Error ? err.message : err);
      estimateStore.at = Date.now();
      estimateStore.failed = true;
    })
    .finally(() => {
      estimateStore.inflight = null;
    });
  return estimateStore.inflight;
}

// The estimate as it should be shown right now. wait = true (tests) calculates it first and waits; otherwise a missing or old estimate starts
// a background calculation and the caller gets the last good value, or "calculating" while the first one runs.
export async function currentEstimate(wait: boolean): Promise<{ estimate: AppointmentEstimate | null; status: EstimateStatus }> {
  // The estimate depends on the dissolved random sample. When the sample has changed since the cached estimate was calculated (or this process
  // never saw it), the cached estimate is wrong, not merely old: drop it so the page shows "Calculating…", recalculates and then refreshes itself.
  if (!wait && !estimateStore.inflight && estimateStore.version !== (await sampleVersion())) Object.assign(estimateStore, { value: null, at: 0, failed: false });
  const age = Date.now() - estimateStore.at;
  const fresh = estimateStore.at > 0 && age < (estimateStore.failed ? ESTIMATE_RETRY_MS : ESTIMATE_TTL_MS);
  if (wait) await startEstimate();
  else if (!fresh) void startEstimate();
  const usable = estimateStore.value && Date.now() - new Date(estimateStore.value.asOf).getTime() < ESTIMATE_KEEP_MS ? estimateStore.value : null;
  if (usable) return { estimate: usable, status: "ready" };
  if (estimateStore.at === 0 || (estimateStore.inflight && !estimateStore.failed)) return { estimate: null, status: "calculating" };
  return { estimate: null, status: "unavailable" };
}

async function build(now: Date): Promise<DirectorProgress> {
  const { counts, jobs, runs, latest, apptsToday, apptsTodayHistorical } = await readSnapshot(now);
  const job = (status: string) => Number(jobs.find((j) => j.status === status)?.n ?? 0);
  const c = (k: string) => Number(counts[k] ?? 0);
  const withDirectors = c("with_directors");
  const checked = c("checked");
  return computeDirectorProgress({
    now,
    totalUk: c("total_uk"),
    eligibleTotal: c("eligible"),
    resolved: checked,
    confirmedAll: c("confirmed_all"),
    confirmedEligible: c("confirmed_eligible"),
    groups: {
      active: { total: c("active_total"), checked: c("active_checked") },
      dissolved: { total: c("dissolved_total"), checked: c("dissolved_checked") },
      other: { total: c("other_total"), checked: c("other_checked") },
    },
    outcomes: { withDirectors, noDirectors: Math.max(0, checked - c("unavailable") - withDirectors), unavailable: c("unavailable") },
    parked: job("parked"),
    retrying: job("retry"),
    processedToday: c("today"),
    lastProcessedAt: counts.last_checked,
    daily: aggregateRuns(runs),
    dailyRequestCap: latestRecordedCap(runs),
    appointmentsToday: apptsToday,
    appointmentsTodayHistorical: apptsTodayHistorical,
    latestRun: latest ? { status: latest.status, heartbeatAt: latest.heartbeatAt, finishedAt: latest.finishedAt, stopReason: stopReasonOf(latest.statsJson) } : null,
  });
}

// The snapshot is refreshed in the background once it is older than ttlMs (default one minute): a viewer is never kept waiting for the
// multi-second scan, and the panel shows when its snapshot was taken. Only the very first request, a snapshot older than MAX_STALE_MS, or
// ttlMs = 0 (tests) waits for a fresh one.
const MAX_STALE_MS = 15 * 60_000;
const snapshotStore = globalThis as unknown as { __directorSnapshot?: { cache: { value: DirectorProgress; at: number } | null; inflight: Promise<DirectorProgress> | null } };
const snap = (snapshotStore.__directorSnapshot ??= { cache: null, inflight: null });

function refresh(now?: Date): Promise<DirectorProgress> {
  snap.inflight ??= build(now ?? new Date())
    .then((value) => {
      snap.cache = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      snap.inflight = null;
    });
  return snap.inflight;
}

async function snapshot(options: { now?: Date; ttlMs?: number }): Promise<DirectorProgress> {
  const ttlMs = options.ttlMs ?? 60_000;
  const age = snap.cache ? Date.now() - snap.cache.at : Infinity;
  if (snap.cache && age < ttlMs) return snap.cache.value;
  if (snap.cache && ttlMs > 0 && age < MAX_STALE_MS) {
    void refresh(options.now).catch(() => {}); // keep showing the last good snapshot if the refresh fails
    return snap.cache.value;
  }
  return refresh(options.now);
}

export async function getDirectorProgress(options: { now?: Date; ttlMs?: number; waitForEstimate?: boolean } = {}): Promise<DirectorProgress> {
  const [progress, est] = await Promise.all([snapshot(options), currentEstimate(options.waitForEstimate === true)]);
  // The estimate is attached HERE, to whichever snapshot is served, so a calculation that finished after the snapshot was built still reaches
  // this very response (and the card and the modal, which share one view object, always show the same estimate and calculation time).
  return { ...progress, appointments: { ...progress.appointments, estimate: est.estimate, estimateStatus: est.status } };
}
