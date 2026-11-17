import { formatDateOnly } from "./format";

// Progress of the director / officer data processing, shown in the "View processing progress" panel of the Director Data card.
//
// Nothing here is stored or simulated: every figure is read from what the existing officer pipeline already records, in ONE database
// snapshot (see director-progress.ts), so the numbers on screen always add up.
//
//   ELIGIBLE   = the companies the pipeline actually works through: real (not seed) UK companies (REAL_COMPANIES_WHERE) that are NOT
//                dissolved. The background crawl (officerQueue.crawlPage) skips dissolved companies on purpose; they are fetched on
//                demand only. It is therefore NOT "all 14 million companies".
//   CHECKED    = eligible companies whose officer data is resolved: officersCoverage "full" (officers fetched) or "unavailable"
//                (Companies House has no officer data). A company is counted once, however often it is refreshed.
//   REMAINING  = ELIGIBLE - CHECKED, exactly. Companies waiting for a retry after a failure, and parked ones, are part of it.
//   PERCENT    = CHECKED / ELIGIBLE x 100.
//   CONFIRMED  = companies with at least one current director (coverage "full" and directorCount > 0). "Checked" is NOT "confirmed": an empty
//                officer list, or a company Companies House holds no officer data for, is checked but has no confirmed director data.
//
// TWO PERCENTAGES, NEVER MIXED UP (these are their only names on screen):
//   "Director Processing Progress"     = CHECKED / ELIGIBLE x 100          (how far the officer worker has got through its own population)
//   "Confirmed Director Data Coverage" = CONFIRMED (all UK companies, any status) / ALL UK COMPANIES x 100
// The confirmed count is taken over ALL UK companies, dissolved ones included: a dissolved company can have confirmed directors because it
// is fetched on demand when someone views, saves or reports on it. It is therefore split in the panel into the part inside the processing
// population (not dissolved) and the part outside it (dissolved), and the two always add up to the headline count.
//
// ELIGIBLE follows the officer worker's own rule (officerQueue.crawlPage): not seed, not dissolved (active companies first, then every other
// live status). It is counted from the rows, not derived by subtracting from the register total.
//   TODAY      = eligible companies checked since 00:00 UTC (Company.officersFetchedAt).
//
//   PACE (for the estimate) = successful crawl completions per UTC day, averaged over up to the last 7 COMPLETE days of scheduler
//   activity, from the officer worker's own run records (IngestionRun kind "officer_backfill", statsJson). Successful = crawled - failures
//   - parked, so failures lower the pace; idle days after the first active day count as zero, so downtime lowers it too. The crawl is
//   used (not every completed fetch) because refreshes of already-checked companies never shorten the backlog. The pace is capped at
//   what the daily request cap allows (cap / measured requests per company), using the cap the worker actually enforced.
//   DAILY API USAGE = Companies House REQUESTS the officer worker has used since 00:00 UTC, against the cap it enforces: the sum of the `requests`
//   its runs recorded today (exactly what officerRequestsSpentToday() adds up for the cap itself), and the cap each run recorded
//   (OFFICER_DAILY_REQUEST_CAP, default 10,000; 0 = none). Requests are NOT companies: a company with no officer data costs two requests.
//   ESTIMATE = ceil(AUTOMATIC BACKLOG / PACE) days from today, where the automatic backlog is REMAINING minus the parked companies (they
//   need a manual retry and will not be checked by the scheduler). With fewer than MIN_HISTORY_DAYS days of history there is no estimate.

export const PACE_WINDOW_DAYS = 7;
export const HISTORY_LOOKBACK_DAYS = 14;
export const MIN_HISTORY_DAYS = 3;
export const RUNNING_FRESH_MS = 3 * 60_000; // a running worker beats every 30 s; three minutes of silence means it is not really running
export const BETWEEN_RUNS_MS = 30 * 60_000; // the scheduler restarts the worker after a run ends, so a short quiet spell is normal
const DAY_MS = 86_400_000;

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS));
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS);

// What the officer worker recorded for one UTC day (the sum of that day's runs, by run start).
export interface DayStats {
  day: string;
  crawled: number;
  processed: number;
  failures: number;
  parked: number;
  requests: number;
  dissolved?: number; // of "crawled": companies taken from the dissolved lane (0 for runs made before that lane existed)
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function aggregateRuns(runs: { startedAt: Date; statsJson: string | null }[]): DayStats[] {
  const byDay = new Map<string, DayStats>();
  for (const r of runs) {
    let s: Record<string, unknown> = {};
    try {
      s = r.statsJson ? (JSON.parse(r.statsJson) as Record<string, unknown>) : {};
    } catch {
      /* unreadable stats: this run contributes nothing */
    }
    const day = utcDay(r.startedAt);
    const d = byDay.get(day) ?? { day, crawled: 0, processed: 0, failures: 0, parked: 0, requests: 0, dissolved: 0 };
    d.dissolved = (d.dissolved ?? 0) + num(s.crawledDissolved);
    d.crawled += num(s.crawled);
    d.processed += num(s.processed);
    d.failures += num(s.failures);
    d.parked += num(s.parked);
    d.requests += num(s.requests);
    byDay.set(day, d);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// The daily request cap the worker most recently enforced (0 = no cap), or null when no run recorded one.
export function latestRecordedCap(runs: { statsJson: string | null }[]): number | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    try {
      const cap = (JSON.parse(runs[i].statsJson ?? "{}") as { dailyRequestCap?: unknown }).dailyRequestCap;
      if (typeof cap === "number" && Number.isFinite(cap) && cap >= 0) return cap;
    } catch {
      /* try the previous run */
    }
  }
  return null;
}

// Why a run stopped ("daily_cap", "idle", "runtime", ...), from its recorded stats.
export function stopReasonOf(statsJson: string | null): string | null {
  try {
    const r = (JSON.parse(statsJson ?? "{}") as { stopReason?: unknown }).stopReason;
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
}

export type EtaState = "estimate" | "calculating" | "no_recent_processing" | "complete" | "manual_retry" | "none";
export type ProcessingState = "complete" | "no_companies" | "not_started" | "processing" | "paused_daily_cap" | "between_runs" | "idle";

export interface LatestRun {
  status: string;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  stopReason: string | null;
}

export const LABEL_PROGRESS = "Director Processing Progress";
export const LABEL_COVERAGE = "Confirmed Director Data Coverage";

export interface DirectorProgressInput {
  now: Date;
  totalUk: number; // every UK company (not seed, not a non-UK type), any status: the denominator of the coverage
  eligibleTotal: number;
  resolved: number; // eligible companies with officersCoverage full | unavailable
  confirmedAll: number; // UK companies of ANY status with confirmed director data: the dashboard card's count
  confirmedEligible: number; // of those, the eligible (not dissolved) ones
  parked: number; // eligible, still unchecked, whose job gave up
  retrying: number; // eligible, still unchecked, waiting for an automatic retry
  processedToday: number;
  lastProcessedAt: Date | null;
  daily: DayStats[];
  dailyRequestCap: number | null;
  latestRun: LatestRun | null;
  // Director APPOINTMENT records (a different thing from companies, requests, officer IDs or people):
  appointmentsToday?: number | null; // CURRENT director / LLP-member appointment rows written since 00:00 UTC (an actual count); null = not measurable
  appointmentsTodayHistorical?: number | null; // ...and the HISTORICAL ones (resigned, or belonging to a dissolved company)
  // The population split by company status group, and how the checked companies came out (all from the same scan as eligibleTotal).
  groups?: { active: StatusGroupCount; dissolved: StatusGroupCount; other: StatusGroupCount };
  outcomes?: { withDirectors: number; noDirectors: number; unavailable: number };
  appointmentEstimate?: AppointmentEstimate | null; // statistical estimate for the unchecked eligible companies (never an exact count)
  appointmentEstimateStatus?: EstimateStatus; // ready | calculating (being worked out right now) | unavailable (failed, or too few checked companies to sample)
}

export type EstimateStatus = "ready" | "calculating" | "unavailable";

// One stratum of the sample: the checked eligible companies (n of them, with the sum s and sum of squares ss of their current director count)
// and the eligible companies that are still unchecked (u). sg = status group, ty = company type group.
export interface AppointmentStratum {
  sg: string;
  ty: string;
  n: number;
  s: number;
  ss: number;
  u: number;
}
export interface AppointmentEstimate {
  // Director + LLP-member appointment records still to import, ALL DATES (current + historical), in the unchecked companies of every status.
  total: number;
  low: number; // 95% interval from SAMPLING error only
  high: number;
  current: { total: number; low: number; high: number }; // no resignation date, company not dissolved
  historical: { total: number; low: number; high: number }; // resigned appointments, and every appointment of a dissolved company
  imported: number; // director + LLP-member appointment records already imported (every checked company, all dates): an ACTUAL count, as of asOf
  checkedCompanies: number; // the sample (companies whose officer data has been fetched or confirmed unavailable)
  uncheckedCompanies: number; // the population the estimate is about
  coveredCompanies: number; // unchecked companies in strata that have a usable sample
  uncoveredCompanies: number; // unchecked companies in strata with no usable sample yet (not guessed, left out of the totals)
  meanPerCompany: number; // appointments (all dates) per checked company
  dissolvedChecked: number; // dissolved companies INDIVIDUALLY checked (every one whose officers were fetched or confirmed unavailable, on demand or sampled)
  dissolvedSampled?: number; // ...of which the resolved members of the approved random sample (these drive the dissolved estimate)
  dissolvedEstimated?: number; // unchecked dissolved companies whose records are ESTIMATED from the random sample: not individually checked
  provisional: boolean; // some unchecked dissolved companies have no usable random sample: the dissolved part is missing, not guessed
  uncheckedDissolved: number; // unchecked dissolved companies (part of uncheckedCompanies)
  asOf: string; // ISO time the sample was read
}

export interface StatusGroupCount {
  total: number;
  checked: number;
}

export type ApiUsageState = "ok" | "no_cap" | "unknown";
export interface ApiUsage {
  state: ApiUsageState; // unknown = no worker run has recorded its cap yet, so nothing is invented
  cap: number | null;
  usedToday: number; // REQUESTS (not companies)
  remaining: number | null;
  percentUsed: number | null;
}

export interface DirectorProgress {
  asOf: string; // when the snapshot was taken (ISO)
  eligibleTotal: number;
  processed: number; // "checked"
  remaining: number; // eligibleTotal - processed
  progressPercent: number; // processed / eligibleTotal x 100
  processedToday: number;
  totalUk: number;
  confirmedAll: number; // the headline count of the Director Data card
  confirmedEligible: number; // ...of which in the processing population (not dissolved)
  confirmedDissolved: number; // ...of which dissolved companies fetched on demand; confirmedEligible + confirmedDissolved = confirmedAll
  coveragePercent: number; // confirmedAll / totalUk x 100
  parked: number;
  retrying: number;
  lastProcessedAt: string | null;
  pace: { perDay: number | null; windowDays: number | null; cap: number | null; capLimited: boolean };
  eta: { state: EtaState; days: number | null; date: string | null };
  status: { state: ProcessingState };
  api: ApiUsage;
  appointments: { importedToday: number | null; importedTodayHistorical: number | null; estimate: AppointmentEstimate | null; estimateStatus: EstimateStatus };
  groups: { active: StatusGroupCount & { remaining: number }; dissolved: StatusGroupCount & { remaining: number }; other: StatusGroupCount & { remaining: number } } | null;
  // Of the checked companies: fetched with director/LLP-member records on file, fetched with none, or confirmed to have no officer data.
  outcomes: { withDirectors: number; noDirectors: number; unavailable: number } | null;
}

function processingState(input: DirectorProgressInput, remaining: number): ProcessingState {
  if (input.eligibleTotal <= 0) return "no_companies"; // 0 of 0 is not "complete": there is simply nothing to process yet
  if (remaining === 0) return "complete";
  const run = input.latestRun;
  if (!run && !input.lastProcessedAt) return "not_started";
  const now = input.now.getTime();
  if (run && run.status === "running" && run.heartbeatAt && now - run.heartbeatAt.getTime() <= RUNNING_FRESH_MS) return "processing";
  if (run?.stopReason === "daily_cap" && run.finishedAt && utcDay(run.finishedAt) === utcDay(input.now)) return "paused_daily_cap";
  const last = [input.lastProcessedAt, run?.heartbeatAt ?? null, run?.finishedAt ?? null].filter((d): d is Date => !!d).map((d) => d.getTime());
  if (last.length && now - Math.max(...last) <= BETWEEN_RUNS_MS) return "between_runs";
  return "idle";
}

// The confirmed-director figures. Confirmed companies inside the processing population can never exceed the companies checked, and the part
// outside it (dissolved, fetched on demand) is what is left of the headline count, so the two parts always add up to it exactly.
function confirmedFigures(input: DirectorProgressInput, processed: number, eligibleTotal: number) {
  // The coverage denominator is every UK company. (The population can also hold a stray non-UK-typed row; it never lowers the denominator.)
  const totalUk = Math.max(input.totalUk, input.confirmedAll, eligibleTotal > 0 && input.totalUk === 0 ? eligibleTotal : 0);
  const confirmedEligible = Math.min(Math.max(0, input.confirmedEligible), processed);
  const confirmedAll = Math.min(Math.max(confirmedEligible, input.confirmedAll), totalUk);
  return {
    confirmedAll,
    confirmedEligible,
    confirmedDissolved: confirmedAll - confirmedEligible,
    coveragePercent: totalUk > 0 ? (confirmedAll / totalUk) * 100 : 0,
  };
}

export function computeDirectorProgress(input: DirectorProgressInput): DirectorProgress {
  const today = utcDay(input.now);
  const eligibleTotal = Math.max(0, input.eligibleTotal);
  const processed = Math.min(Math.max(0, input.resolved), eligibleTotal);
  const remaining = eligibleTotal - processed; // the definition: eligible minus checked, with nothing else deducted
  const parked = Math.min(Math.max(0, input.parked), remaining);
  const retrying = Math.min(Math.max(0, input.retrying), remaining - parked);
  const automaticBacklog = remaining - parked;

  // ---- pace, from complete UTC days only (today is still in progress and would understate the pace every morning) ----
  const byDay = new Map(input.daily.map((d) => [d.day, d]));
  const successes = (day: string) => {
    const d = byDay.get(day);
    return d ? Math.max(0, d.crawled - d.failures - d.parked) : 0;
  };
  let firstActive: string | null = null;
  for (let i = HISTORY_LOOKBACK_DAYS; i >= 1; i--) {
    const day = addDays(today, -i);
    if (successes(day) > 0) {
      firstActive = day;
      break;
    }
  }
  let perDay: number | null = null;
  let windowDays: number | null = null;
  let capLimited = false;
  let enoughHistory = false;
  let noRecent = false;
  if (firstActive) {
    const earliestWindowDay = addDays(today, -PACE_WINDOW_DAYS);
    const windowStart = firstActive > earliestWindowDay ? firstActive : earliestWindowDay;
    const days = daysBetween(windowStart, today);
    if (days >= MIN_HISTORY_DAYS) {
      enoughHistory = true;
      let done = 0;
      let companies = 0;
      let requests = 0;
      for (let i = 0; i < days; i++) {
        const day = addDays(windowStart, i);
        done += successes(day);
        companies += byDay.get(day)?.processed ?? 0;
        requests += byDay.get(day)?.requests ?? 0;
      }
      if (done === 0) {
        noRecent = true;
      } else {
        windowDays = days;
        perDay = done / days;
        const cap = input.dailyRequestCap;
        if (cap !== null && cap > 0) {
          const perCompany = companies > 0 ? Math.max(1, requests / companies) : 1; // "no officer data" companies cost two requests
          const ceiling = cap / perCompany;
          if (ceiling < perDay) {
            perDay = ceiling;
            capLimited = true;
          }
        }
      }
    }
  }

  // ---- today's Companies House requests against the cap the worker enforces ----
  const usedToday = Math.round(byDay.get(today)?.requests ?? 0);
  const cap = input.dailyRequestCap;
  const api: ApiUsage =
    cap === null
      ? { state: "unknown", cap: null, usedToday, remaining: null, percentUsed: null }
      : cap === 0
        ? { state: "no_cap", cap: 0, usedToday, remaining: null, percentUsed: null }
        : { state: "ok", cap, usedToday, remaining: Math.max(0, cap - usedToday), percentUsed: Math.min(100, (usedToday / cap) * 100) };

  // ---- the estimate: only from real history, only for the work the scheduler will actually do ----
  let eta: DirectorProgress["eta"];
  if (eligibleTotal === 0) eta = { state: "none", days: null, date: null };
  else if (remaining === 0) eta = { state: "complete", days: null, date: null };
  else if (automaticBacklog === 0) eta = { state: "manual_retry", days: null, date: null };
  else if (!enoughHistory) eta = { state: "calculating", days: null, date: null };
  else if (noRecent || !perDay) eta = { state: "no_recent_processing", days: null, date: null };
  else {
    const days = Math.ceil(automaticBacklog / perDay);
    eta = { state: "estimate", days, date: addDays(today, days) };
  }

  return {
    asOf: input.now.toISOString(),
    eligibleTotal,
    processed,
    remaining,
    progressPercent: eligibleTotal > 0 ? (processed / eligibleTotal) * 100 : 0,
    processedToday: Math.max(0, input.processedToday),
    totalUk: Math.max(input.totalUk, input.confirmedAll, eligibleTotal > 0 && input.totalUk === 0 ? eligibleTotal : 0),
    ...confirmedFigures(input, processed, eligibleTotal),
    parked,
    retrying,
    lastProcessedAt: input.lastProcessedAt ? input.lastProcessedAt.toISOString() : null,
    pace: { perDay, windowDays, cap: input.dailyRequestCap, capLimited },
    eta,
    status: { state: processingState(input, remaining) },
    api,
    appointments: {
      importedToday: input.appointmentsToday === undefined || input.appointmentsToday === null ? null : Math.max(0, Math.round(input.appointmentsToday)),
      importedTodayHistorical: input.appointmentsTodayHistorical === undefined || input.appointmentsTodayHistorical === null ? null : Math.max(0, Math.round(input.appointmentsTodayHistorical)),
      estimate: input.appointmentEstimate ?? null,
      estimateStatus: input.appointmentEstimate ? "ready" : input.appointmentEstimateStatus === "calculating" ? "calculating" : "unavailable",
    },
    groups: statusGroups(input, eligibleTotal),
    outcomes: input.outcomes ? { withDirectors: Math.max(0, input.outcomes.withDirectors), noDirectors: Math.max(0, input.outcomes.noDirectors), unavailable: Math.max(0, input.outcomes.unavailable) } : null,
  };
}

// Active / dissolved / other: only used when the three groups add up to the eligible population, so a partial feed can never show a total that
// disagrees with the headline.
function statusGroups(input: DirectorProgressInput, eligibleTotal: number) {
  const g = input.groups;
  if (!g) return null;
  const sum = g.active.total + g.dissolved.total + g.other.total;
  if (sum !== eligibleTotal) return null;
  const one = (c: StatusGroupCount) => ({ total: c.total, checked: Math.min(c.checked, c.total), remaining: c.total - Math.min(c.checked, c.total) });
  return { active: one(g.active), dissolved: one(g.dissolved), other: one(g.other) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ESTIMATED REMAINING DIRECTOR APPOINTMENTS (an estimate, never a count)
//   Sample = the eligible companies already checked (the crawl visits them in random id order). For each stratum (status group, company
//   type, incorporation year, dormant flag) the mean current director count of the checked companies is applied to that stratum's
//   unchecked companies; the strata are summed. Strata with fewer than 30 checked companies are pooled into (status, type), then into the
//   status group, so a thin stratum can never produce a wild mean. The range is +/-1.96 standard errors: SAMPLING error only, it cannot
//   see a systematic difference between checked and unchecked companies. Companies are not people: this counts appointments.
// ---------------------------------------------------------------------------------------------------------------------------------
export const MIN_STRATUM_SAMPLE = 30;
// A dissolved-company sample smaller than this is called PROVISIONAL: the dissolved part of the estimate rests on too few checked companies.
export const DISSOLVED_SAMPLE_PROVISIONAL_BELOW = 5_000; // (retired: dissolved companies are estimated ONLY from the tagged random sample, see estimateDissolvedFromSample)

// ---------------------------------------------------------------------------------------------------------------------------------
// DISSOLVED companies: a stratified RANDOM sample, one stratum per dissolution year (2009 = before 2010 or no date). The sample of a year is a
// simple random sample of the never-checked dissolved companies of that year. The estimate for the stratum is U x mean(sample records), where U is
// the number of that year's dissolved companies still unchecked; its variance is U^2 (1 - n/(U+n)) s^2 / n (finite-population correction). The
// year weights are the real population sizes U, so a year with many more companies counts for proportionally more. A year is COVERED only with at
// least MIN_DISSOLVED_STRATUM_SAMPLE resolved sampled companies; an uncovered year is left out and reported, never guessed.
// "Covered" means an ESTIMATE exists for that year. It does not mean the companies were individually checked: they were not.
// ---------------------------------------------------------------------------------------------------------------------------------
export const MIN_DISSOLVED_STRATUM_SAMPLE = 30;
export interface DissolvedSampleStratum {
  year: number;
  n: number; // resolved sampled companies (fetched, confirmed unavailable, or checked by someone else before we reached them)
  sum: number; // their director + LLP-member records
  sumSq: number;
}
export interface DissolvedStratumResult {
  year: number;
  unchecked: number; // U
  n: number;
  mean: number;
  se: number; // standard error of the stratum's estimated total
  total: number;
  low: number;
  high: number;
  covered: boolean;
}
export function estimateDissolvedFromSample(unchecked: Map<number, number>, sample: DissolvedSampleStratum[]) {
  const by = new Map(sample.map((x) => [x.year, x]));
  const years = [...new Set([...unchecked.keys(), ...by.keys()])].sort((a, b) => a - b);
  const strata: DissolvedStratumResult[] = [];
  let total = 0, variance = 0, covered = 0, uncovered = 0, sampled = 0;
  for (const year of years) {
    const U = unchecked.get(year) ?? 0;
    const x = by.get(year) ?? { year, n: 0, sum: 0, sumSq: 0 };
    sampled += x.n;
    const ok = x.n >= MIN_DISSOLVED_STRATUM_SAMPLE;
    const mean = x.n ? x.sum / x.n : 0;
    const s2 = x.n > 1 ? Math.max(0, (x.sumSq - x.n * mean * mean) / (x.n - 1)) : 0;
    const v = ok && U > 0 ? U * U * (U / (U + x.n)) * (s2 / x.n) : 0;
    const t = ok ? U * mean : 0;
    if (U > 0) {
      if (ok) covered += U;
      else uncovered += U;
    }
    total += t;
    variance += v;
    const se = Math.sqrt(v);
    strata.push({ year, unchecked: U, n: x.n, mean, se, total: Math.round(t), low: Math.max(0, Math.round(t - 1.96 * se)), high: Math.round(t + 1.96 * se), covered: ok || U === 0 });
  }
  return { total, variance, covered, uncovered, sampled, strata };
}

type Var = "cur" | "hist" | "all";
const VARS: Var[] = ["cur", "hist", "all"];
export interface SplitStratum {
  sg: string; // status group: active | dissolved | other
  ty: string; // company type group
  yr?: string | number; // incorporation year (pre-1990 pooled)
  dm?: string | boolean; // dormant flag
  dy?: string | number; // dissolution year (dissolved companies only: older dissolutions are less likely to still be served by Companies House)
  n: number; // checked companies (officers fetched, or Companies House has no officer data: those count as 0 appointments)
  u: number; // companies still unchecked
  v: Record<Var, { s: number; ss: number }>; // sum and sum of squares of each company's appointment count: cur / hist / all
}

// Pooling rule shared by every variable. A stratum with fewer than MIN_STRATUM_SAMPLE checked companies is pooled with its siblings, step by
// step (live companies: type, then status group; dissolved companies: type + dissolution year, then dissolution year). A dissolved stratum is
// never pooled ACROSS dissolution years: a company dissolved in 2012 must not borrow the average of companies dissolved last month. If its
// dissolution year still has too few checked companies it is reported as NOT COVERED instead of being guessed.
function poolStrata(rows: SplitStratum[]) {
  const keys = (r: SplitStratum & { _i?: number }): string[] => {
    const dy = String(r.dy ?? "");
    return r.sg === "dissolved" ? ["#" + r._i, r.sg + "|" + r.ty + "|" + dy, r.sg + "|" + dy] : ["#" + r._i, r.sg + "|" + r.ty, r.sg];
  };
  type Agg = { n: number; u: number; v: Record<Var, { s: number; ss: number }> };
  const fresh = (): Agg => ({ n: 0, u: 0, v: { cur: { s: 0, ss: 0 }, hist: { s: 0, ss: 0 }, all: { s: 0, ss: 0 } } });
  const add = (a: Agg, r: SplitStratum) => {
    a.n += r.n;
    a.u += r.u;
    for (const k of VARS) {
      a.v[k].s += r.v[k].s;
      a.v[k].ss += r.v[k].ss;
    }
  };
  const finals: Agg[] = [];
  let uncovered = 0;
  // Level 0 is the stratum itself (rows are already one per stratum); levels 1 and 2 pool thin siblings.
  type Tagged = SplitStratum & { _i: number };
  let pending: Tagged[] = rows.map((r, i) => ({ ...r, _i: i })).filter((r) => r.n > 0 || r.u > 0);
  for (let level = 0; level < 3 && pending.length; level++) {
    const groups = new Map<string, Agg>();
    for (const r of pending) {
      const k = keys(r)[level];
      const g = groups.get(k) ?? fresh();
      add(g, r);
      groups.set(k, g);
    }
    const emitted = new Set<string>();
    const carry: Tagged[] = [];
    for (const r of pending) {
      const k = keys(r)[level];
      const g = groups.get(k)!;
      if (g.n >= MIN_STRATUM_SAMPLE) {
        if (!emitted.has(k)) {
          emitted.add(k);
          finals.push(g);
        }
      } else if (level < 2) carry.push(r);
      else if (r.sg !== "dissolved") {
        if (!emitted.has(k)) {
          emitted.add(k);
          finals.push(g); // live companies: the status group is the last resort, as before
        }
      } else uncovered += r.u; // dissolved: not covered
    }
    pending = carry;
  }
  return { finals, uncovered };
}

function estimateParts(finals: ReturnType<typeof poolStrata>["finals"], asOf: Date) {
  const out = {} as Record<Var, { total: number; low: number; high: number; mean: number }>;
  let sample = 0, unchecked = 0, uncoveredThin = 0;
  for (const g of finals) {
    sample += g.n;
    if (g.n < 2) uncoveredThin += g.u;
    else unchecked += g.u;
  }
  for (const k of VARS) {
    let total = 0, variance = 0, sum = 0;
    for (const g of finals) {
      sum += g.v[k].s;
      if (g.n < 2) continue;
      const mean = g.v[k].s / g.n;
      const v = Math.max(0, (g.v[k].ss - g.n * mean * mean) / (g.n - 1));
      total += g.u * mean;
      variance += (g.u * g.u * v) / g.n;
    }
    const se = Math.sqrt(variance);
    out[k] = { total: Math.round(total), low: Math.max(0, Math.round(total - 1.96 * se)), high: Math.round(total + 1.96 * se), mean: sample ? sum / sample : 0 };
  }
  void asOf;
  return { parts: out, sample, covered: unchecked, uncoveredThin };
}

export interface EstimatePart {
  total: number;
  low: number;
  high: number;
}

/** The estimate over the WHOLE register (active, dissolved and other statuses), split into current and historical appointments. */
export function estimateAppointmentSplit(rows: SplitStratum[], asOf: Date, dissolvedSample?: DissolvedSampleStratum[]): AppointmentEstimate | null {
  const dissolvedChecked = rows.filter((r) => r.sg === "dissolved").reduce((a, r) => a + r.n, 0);
  const dissolvedUnchecked = rows.filter((r) => r.sg === "dissolved").reduce((a, r) => a + r.u, 0);
  // Dissolved companies are NEVER extrapolated from the companies somebody happened to check (they are the ones asked for, not a random sample).
  // They are estimated only from the tagged random sample (dissolvedSample), year by year; without it they are left out and reported. Their
  // records that are already imported are still counted exactly (imported).
  const unCheckedByYear = new Map<number, number>();
  for (const r of rows) if (r.sg === "dissolved") unCheckedByYear.set(Number(r.dy ?? 2009), (unCheckedByYear.get(Number(r.dy ?? 2009)) ?? 0) + r.u);
  const d = dissolvedSample ? estimateDissolvedFromSample(unCheckedByYear, dissolvedSample) : null;
  const provisional = dissolvedUnchecked > 0 && (!d || d.uncovered > 0);
  const { finals, uncovered } = poolStrata(rows.filter((r) => r.sg !== "dissolved"));
  const { parts, covered, uncoveredThin } = estimateParts(finals, asOf);
  const sample = rows.reduce((a, r) => a + r.n, 0); // every checked company, whether or not its stratum could be used
  if (sample < 2) return null;
  const meanAll = rows.reduce((a, r) => a + r.v.all.s, 0) / sample;
  const unchecked = rows.reduce((a, r) => a + r.u, 0);
  const part = (k: Var): EstimatePart => ({ total: parts[k].total, low: parts[k].low, high: parts[k].high });
  // live part + dissolved part (all dissolved appointments are historical); independent samples, so variances add
  const dTotal = d ? Math.round(d.total) : 0;
  const joint = (live: { total: number; high: number }): EstimatePart => {
    const se = Math.sqrt(Math.pow(Math.max(0, live.high - live.total) / 1.96, 2) + (d ? d.variance : 0));
    const t = live.total + dTotal;
    return { total: t, low: Math.max(0, Math.round(t - 1.96 * se)), high: Math.round(t + 1.96 * se) };
  };
  const hist = joint(parts.hist);
  const allPart = joint({ total: parts.cur.total + parts.hist.total, high: parts.all.high });
  return {
    ...allPart, // the range of the all-dates estimate; the total below is summed so the three figures always add up
    total: parts.cur.total + hist.total,
    current: part("cur"),
    historical: hist,
    imported: rows.reduce((a, r) => a + r.v.all.s, 0),
    checkedCompanies: sample,
    uncheckedCompanies: unchecked,
    coveredCompanies: covered + (d ? Math.round(d.covered) : 0),
    uncoveredCompanies: uncovered + uncoveredThin + (d ? d.uncovered : dissolvedUnchecked),
    meanPerCompany: meanAll,
    dissolvedChecked,
    dissolvedSampled: d ? d.sampled : 0,
    dissolvedEstimated: d ? Math.round(d.covered) : 0,
    provisional, // true = some unchecked dissolved companies have no usable random sample: they are left out of the estimate
    uncheckedDissolved: dissolvedUnchecked,
    asOf: asOf.toISOString(),
  };
}

/** Single-variable form (kept for the original calculation and its tests): every row carries one count per company. */
export function estimateRemainingAppointments(rows: (AppointmentStratum & { key?: string })[], asOf: Date): AppointmentEstimate | null {
  const split: SplitStratum[] = rows.map((r) => ({ sg: r.sg, ty: r.ty, n: r.n, u: r.u, v: { cur: { s: r.s, ss: r.ss }, hist: { s: 0, ss: 0 }, all: { s: r.s, ss: r.ss } } }));
  return estimateAppointmentSplit(split, asOf);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// ESTIMATED TIME TO COMPLETE, from ACTUAL RECORDS imported per day (never companies processed, never API requests).
//   History = the director / LLP-member rows inserted per UTC day (Director.createdAt; a company's rows are written once, when its officers are
//   first fetched, so a day's rows are that day's imports). Pace = the records imported over the last RECORD_PACE_WINDOW_DAYS COMPLETE UTC days
//   divided by the number of those days, so days with no import (a stopped worker, a sleeping laptop) count as zero and the estimate is honest
//   about downtime. Today is a partial day and is never used. Remaining = estimated total - imported (the verified estimate's remaining records).
//   Needs at least RECORD_PACE_MIN_DAYS complete days since the first import, otherwise it says so instead of guessing.
// ---------------------------------------------------------------------------------------------------------------------------------
export const RECORD_PACE_WINDOW_DAYS = 7;
export const RECORD_PACE_MIN_DAYS = 3;
export interface RecordDay {
  day: string; // UTC date, yyyy-mm-dd
  records: number;
}
export interface RecordCompletion {
  state: "estimate" | "complete" | "no_history" | "no_recent_imports";
  perDay: number | null; // records a day over the window
  windowDays: number;
  days: number | null;
  date: string | null; // yyyy-mm-dd
  recordsInWindow: number;
}
export function projectRecordCompletion(i: { now: Date; daily: RecordDay[]; firstDay: string | null; remaining: number }): RecordCompletion {
  const today = utcDay(i.now);
  const none = (state: RecordCompletion["state"], windowDays = 0, recordsInWindow = 0): RecordCompletion => ({ state, perDay: null, windowDays, days: null, date: null, recordsInWindow });
  if (i.remaining <= 0) return none("complete");
  const first = i.firstDay ?? (i.daily.length ? i.daily.map((d) => d.day).sort()[0] : null);
  if (!first || first >= today) return none("no_history");
  const complete = Math.round((Date.parse(today + "T00:00:00Z") - Date.parse(first + "T00:00:00Z")) / DAY_MS); // complete UTC days since the first import day (inclusive)
  if (complete < RECORD_PACE_MIN_DAYS) return none("no_history");
  const windowDays = Math.min(RECORD_PACE_WINDOW_DAYS, complete);
  let recordsInWindow = 0;
  for (let k = 1; k <= windowDays; k++) recordsInWindow += i.daily.find((d) => d.day === addDays(today, -k))?.records ?? 0;
  if (recordsInWindow <= 0) return none("no_recent_imports", windowDays, 0);
  const perDay = recordsInWindow / windowDays;
  const days = Math.max(1, Math.ceil(i.remaining / perDay));
  return { state: "estimate", perDay, windowDays, days, date: addDays(today, days), recordsInWindow };
}

// One rounded approximate figure for the headline estimate: "32M", "2.4M", "850K". Estimates only.
export function formatApprox(v: number): string {
  const x = Math.max(0, v);
  if (x >= 10_000_000) return Math.round(x / 1_000_000) + "M";
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(1) + "M";
  if (x >= 10_000) return Math.round(x / 1_000) + "K";
  return Math.round(x).toLocaleString("en-GB");
}

// "7.94M", "812K", "950": compact on purpose, and used for estimates only.
export function formatCompact(v: number): string {
  const x = Math.max(0, v);
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(2) + "M";
  if (x >= 10_000) return Math.round(x / 1_000) + "K";
  return Math.round(x).toLocaleString("en-GB");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Wording. All of it is produced here, on the server, so the browser only shows strings and never re-formats a number.
// ---------------------------------------------------------------------------------------------------------------------------------

// "about 7 months", "3 weeks", "12 days": coarse on purpose, an estimate must not look more exact than it is.
export function formatDuration(days: number): string {
  if (days <= 1) return "1 day";
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  const months = days / 30.44;
  if (months < 24) return `${Math.round(months)} months`;
  return `${(months / 12).toFixed(1)} years`;
}

export function formatEta(eta: DirectorProgress["eta"]): string {
  switch (eta.state) {
    case "estimate":
      return `${formatDuration(eta.days ?? 0)} · ${formatDateOnly(eta.date)}`;
    case "complete":
      return "Complete";
    case "no_recent_processing":
      return "No recent processing";
    case "manual_retry":
      return "Waiting for a manual retry";
    case "none":
      return "—";
    default:
      return "Calculating estimate";
  }
}

export const formatPercent = (p: number) => (p === 0 ? "0%" : p < 0.01 ? "<0.01%" : p < 10 ? `${p.toFixed(2)}%` : `${p.toFixed(1)}%`);
const n = (v: number) => v.toLocaleString("en-GB");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "15 Nov 2026, 14:05 UTC", written by hand so the server and any browser can never disagree about it.
export function formatDateTimeUtc(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const p2 = (v: number) => String(v).padStart(2, "0");
  return `${p2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}

export type StatusTone = "green" | "amber" | "violet" | "slate";
export interface DirectorProgressView {
  asOfText: string;
  // Director Processing Progress: checked / eligible (the officer worker's own population)
  percentText: string;
  barPercent: number;
  eligible: string;
  checked: string;
  remaining: string;
  today: string;
  rate: string;
  rateNote: string | null;
  etaMain: string; // the date, or "Calculating estimate" ...
  etaSub: string | null; // "About 7 months"
  eta: string; // both in one line
  lastUpdate: string;
  status: { label: string; detail: string; tone: StatusTone };
  // Daily API usage: REQUESTS used today against the cap the worker enforces (never a company count)
  api: { state: ApiUsageState; used: string; cap: string | null; remaining: string | null; percentText: string | null; barPercent: number; warn: boolean };
  // Confirmed Director Data Coverage: confirmed / all UK companies (the dashboard card's own figure, from this same snapshot)
  coverage: { percentText: string; confirmed: string; totalUk: string };
  // Director APPOINTMENT records. today = an ACTUAL count (rows written since 00:00 UTC); estimate = a statistical estimate, shown as such.
  appts: {
    today: string | null; // appointment records written since 00:00 UTC: current + historical
    todayCurrent: string | null;
    todayHistorical: string | null;
    estimate: string | null; // remaining appointment records, all dates, as an ESTIMATE
    range: string | null;
    estimateCurrent: string | null;
    estimateHistorical: string | null;
    note: string | null; // "provisional" / "excludes N companies not yet sampled"
    partial: boolean; // the estimate leaves out companies that have no usable sample yet, so the true figure is higher ("15.67M+")
    estimateTitle: string | null;
    state: EstimateStatus;
    calculatedAt: string | null;
  };
  // The population by status group (active / dissolved / other non-active) with checked and remaining, and how the checked companies came out.
  groups: { key: string; label: string; total: string; checked: string; remaining: string; percent: string }[] | null;
  outcomes: { withDirectors: string; noDirectors: string; unavailable: string } | null;
  attention: string[];
}

const STATUS: Record<ProcessingState, { label: string; detail: string; tone: StatusTone }> = {
  complete: { label: "Complete", detail: "Every eligible company has been checked.", tone: "green" },
  no_companies: { label: "Nothing to process", detail: "There are no eligible companies yet.", tone: "slate" },
  processing: { label: "Processing now", detail: "The worker is running and checking companies.", tone: "green" },
  paused_daily_cap: { label: "Paused: daily limit reached", detail: "Processing resumes after 00:00 UTC.", tone: "amber" },
  between_runs: { label: "Between runs", detail: "The scheduler restarts the worker automatically.", tone: "violet" },
  idle: { label: "Not running", detail: "No processing activity for over 30 minutes.", tone: "amber" },
  not_started: { label: "Not started", detail: "No processing has been recorded yet.", tone: "slate" },
};

// ---------------------------------------------------------------------------------------------------------------------------------
// ESTIMATED TIME TO COMPLETE. The same pace rule as the processing panel, applied to EVERY unchecked company (live and dissolved):
//   pace = successful companies per day (crawled - failures - parked, all statuses, both crawl lanes) over the last complete UTC days of real
//   history, held to the daily request cap; time = unchecked companies (less parked ones) / pace. The live/dissolved allocation only decides
//   which lane finishes first, not when the last company is done, so the total does not depend on it as long as both lanes keep working.
//   PROVISIONAL while the dissolved lane has too little history: before it has run, the pace is that of live companies only, and a dissolved
//   company can cost more (a company with no officer data costs two requests). Never a date without real processing history.
// ---------------------------------------------------------------------------------------------------------------------------------
export const DISSOLVED_HISTORY_MIN = 2_000;
export interface Completion {
  state: EtaState;
  days: number | null;
  date: string | null;
  perDay: number | null;
  windowDays: number | null;
  capLimited: boolean;
  provisional: boolean;
  dissolvedHistory: number; // dissolved companies processed in the pace window
  dissolvedToday?: number; // dissolved companies processed so far today (a partial day: not yet usable history, only a sign that processing has started)
}
export function projectCompletion(i: { now: Date; daily: DayStats[]; remaining: number; dissolvedRemaining: number; parked: number; cap: number | null }): Completion {
  const p = computeDirectorProgress({
    now: i.now, totalUk: i.remaining, eligibleTotal: i.remaining, resolved: 0, confirmedAll: 0, confirmedEligible: 0, parked: i.parked, retrying: 0,
    processedToday: 0, lastProcessedAt: null, daily: i.daily, dailyRequestCap: i.cap, latestRun: null,
  });
  const today = utcDay(i.now);
  let dissolvedHistory = 0;
  for (let k = 1; k <= PACE_WINDOW_DAYS; k++) dissolvedHistory += i.daily.find((d) => d.day === addDays(today, -k))?.dissolved ?? 0;
  return {
    state: p.eta.state, days: p.eta.days, date: p.eta.date, perDay: p.pace.perDay, windowDays: p.pace.windowDays, capLimited: p.pace.capLimited,
    provisional: i.dissolvedRemaining > 0 && dissolvedHistory < DISSOLVED_HISTORY_MIN, dissolvedHistory,
    dissolvedToday: i.daily.find((d) => d.day === today)?.dissolved ?? 0,
  };
}

export function estimateNote(e: AppointmentEstimate | null): string | null {
  if (!e) return null;
  const parts: string[] = [];
  if (e.provisional) parts.push("provisional: dissolved companies have no usable random sample yet");
  if (e.uncoveredCompanies > 0) parts.push("excludes " + e.uncoveredCompanies.toLocaleString("en-GB") + " companies not yet sampled");
  return parts.length ? parts.join("; ") : null;
}

export function toDirectorProgressView(p: DirectorProgress): DirectorProgressView {
  const estimateHasRate = p.pace.perDay !== null;
  const attention: string[] = [];
  if (p.retrying > 0) attention.push(`${n(p.retrying)} awaiting an automatic retry`);
  if (p.parked > 0) attention.push(`${n(p.parked)} parked after repeated failures (need a manual retry)`);
  const isEstimate = p.eta.state === "estimate";
  const a = p.api;
  return {
    asOfText: formatDateTimeUtc(p.asOf),
    percentText: formatPercent(p.progressPercent),
    barPercent: Math.max(p.progressPercent, p.progressPercent > 0 ? 1 : 0),
    eligible: n(p.eligibleTotal),
    checked: n(p.processed),
    remaining: n(p.remaining),
    today: n(p.processedToday),
    rate: estimateHasRate ? `${n(Math.round(p.pace.perDay as number))} a day` : p.eta.state === "no_recent_processing" ? "No recent processing" : p.eta.state === "complete" || p.eta.state === "none" ? "—" : "Calculating estimate",
    rateNote: estimateHasRate ? (p.pace.capLimited ? "Limited by the daily cap" : `Last ${p.pace.windowDays} days`) : null,
    etaMain: isEstimate ? formatDateOnly(p.eta.date) : formatEta(p.eta),
    etaSub: isEstimate ? `About ${formatDuration(p.eta.days ?? 0)}${p.parked > 0 ? `, excluding ${n(p.parked)} parked` : ""}` : null,
    eta: formatEta(p.eta),
    lastUpdate: p.lastProcessedAt ? formatDateTimeUtc(p.lastProcessedAt) : "No processing recorded yet",
    status: STATUS[p.status.state],
    api: {
      state: a.state,
      used: n(a.usedToday),
      cap: a.cap !== null && a.cap > 0 ? n(a.cap) : null,
      remaining: a.remaining !== null ? n(a.remaining) : null,
      percentText: a.percentUsed !== null ? formatPercent(a.percentUsed) : null,
      barPercent: a.percentUsed !== null ? Math.max(a.percentUsed, a.percentUsed > 0 ? 1 : 0) : 0,
      warn: a.percentUsed !== null && a.percentUsed >= 90,
    },
    coverage: { percentText: formatPercent(p.coveragePercent), confirmed: n(p.confirmedAll), totalUk: n(p.totalUk) },
    appts: {
      state: p.appointments.estimateStatus,
      calculatedAt: p.appointments.estimate ? formatDateTimeUtc(p.appointments.estimate.asOf) : null,
      today: p.appointments.importedToday === null ? null : n(p.appointments.importedToday + (p.appointments.importedTodayHistorical ?? 0)),
      todayCurrent: p.appointments.importedToday === null ? null : n(p.appointments.importedToday),
      todayHistorical: p.appointments.importedTodayHistorical === null ? null : n(p.appointments.importedTodayHistorical),
      estimate: p.appointments.estimate ? formatCompact(p.appointments.estimate.total) : null,
      range: p.appointments.estimate ? formatCompact(p.appointments.estimate.low) + "–" + formatCompact(p.appointments.estimate.high) : null,
      estimateCurrent: p.appointments.estimate ? formatCompact(p.appointments.estimate.current.total) : null,
      estimateHistorical: p.appointments.estimate ? formatCompact(p.appointments.estimate.historical.total) : null,
      note: estimateNote(p.appointments.estimate),
      partial: !!p.appointments.estimate && p.appointments.estimate.uncoveredCompanies > 0,
      estimateTitle: p.appointments.estimate
        ? "Estimate, not an exact count: about " + formatCompact(p.appointments.estimate.total) + " director and LLP-member appointment records still to import (range " + formatCompact(p.appointments.estimate.low) + "–" + formatCompact(p.appointments.estimate.high) + "), of which about " + formatCompact(p.appointments.estimate.current.total) + " current and " + formatCompact(p.appointments.estimate.historical.total) + " historical (resigned, or in dissolved companies). Based on " + n(p.appointments.estimate.checkedCompanies) + " checked companies averaging " + p.appointments.estimate.meanPerCompany.toFixed(2) +
          " appointment records, applied by company status, type and age to " + n(p.appointments.estimate.coveredCompanies) + " of the " + n(p.appointments.estimate.uncheckedCompanies) + " unchecked companies. The range reflects sampling error only. Appointments, not unique people. Calculated " +
          formatDateTimeUtc(p.appointments.estimate.asOf) + "."
        : null,
    },
    groups: p.groups
      ? (["active", "dissolved", "other"] as const).map((k) => ({
          key: k,
          label: k === "active" ? "Active" : k === "dissolved" ? "Dissolved" : "Other non-active",
          total: n(p.groups![k].total),
          checked: n(p.groups![k].checked),
          remaining: n(p.groups![k].remaining),
          percent: formatPercent(p.groups![k].total > 0 ? (p.groups![k].checked / p.groups![k].total) * 100 : 0),
        }))
      : null,
    outcomes: p.outcomes ? { withDirectors: n(p.outcomes.withDirectors), noDirectors: n(p.outcomes.noDirectors), unavailable: n(p.outcomes.unavailable) } : null,
    attention,
  };
}
