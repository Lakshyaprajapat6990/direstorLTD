import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  addDays,
  aggregateRuns,
  computeDirectorProgress,
  estimateRemainingAppointments,
  formatCompact,
  formatDateTimeUtc,
  formatDuration,
  formatEta,
  formatPercent,
  LABEL_COVERAGE,
  LABEL_PROGRESS,
  latestRecordedCap,
  stopReasonOf,
  toDirectorProgressView,
  type DayStats,
  type DirectorProgressInput,
  type LatestRun,
} from "@/lib/data/director-progress-calc";

// The Director Data progress figures and the estimate. Pure: no database. "Now" is 2026-11-15 14:05 UTC, so the last complete days are
// 11-14 (-1) ... 11-08 (-7).
const NOW = new Date("2026-11-15T14:05:00Z");
const TODAY = "2026-11-15";
const day = (back: number) => addDays(TODAY, -back);
const d = (back: number, crawled: number, extra: Partial<DayStats> = {}): DayStats => ({ day: day(back), crawled, processed: crawled, failures: 0, parked: 0, requests: crawled, ...extra });
const RUNNING: LatestRun = { status: "running", heartbeatAt: new Date("2026-11-15T14:04:40Z"), finishedAt: null, stopReason: null };
const input = (over: Partial<DirectorProgressInput> = {}): DirectorProgressInput => ({
  now: NOW,
  totalUk: 14_034_565,
  eligibleTotal: 5_679_706,
  resolved: 463_905,
  confirmedAll: 453_208, // the dashboard card: every UK company with confirmed directors, dissolved ones included
  confirmedEligible: 452_000, // ...of which not dissolved (the processing population); the other 1,208 are dissolved, fetched on demand
  parked: 0,
  retrying: 0,
  processedToday: 18_223,
  lastProcessedAt: new Date("2026-11-15T14:03:10Z"),
  daily: [],
  dailyRequestCap: 100_000,
  latestRun: RUNNING,
  ...over,
});
const THREE_STEADY_DAYS = [3, 2, 1].map((b) => d(b, 30_000));

// ---- the two formulas, exactly ------------------------------------------------------------------------------------------------------
test("Remaining = eligible - checked, and Percentage = checked / eligible x 100, exactly", () => {
  const p = computeDirectorProgress(input());
  assert.equal(p.remaining, 5_679_706 - 463_905);
  assert.equal(p.progressPercent, (463_905 / 5_679_706) * 100);
  assert.equal(p.processed + p.remaining, p.eligibleTotal);
});

test("the identities hold for any figures, whatever the failures, retries or parking", () => {
  for (const [eligible, checked, parked, retrying] of [[100, 40, 10, 5], [1, 0, 0, 0], [0, 0, 0, 0], [5_679_706, 5_679_706, 0, 0], [1_000_000, 123_457, 900, 40_000], [50, 50, 3, 3]]) {
    const p = computeDirectorProgress(input({ eligibleTotal: eligible, resolved: checked, parked, retrying }));
    assert.equal(p.remaining, p.eligibleTotal - p.processed, `${eligible}/${checked}`);
    assert.equal(p.processed + p.remaining, p.eligibleTotal);
    if (eligible > 0) assert.equal(p.progressPercent, (p.processed / eligible) * 100);
    assert.ok(p.progressPercent >= 0 && p.progressPercent <= 100);
  }
});

test("parked and retrying companies are PART of the remaining count (nothing is deducted), and are reported separately", () => {
  const p = computeDirectorProgress(input({ eligibleTotal: 100, resolved: 40, parked: 10, retrying: 5 }));
  assert.equal(p.remaining, 60);
  assert.equal(p.parked, 10);
  assert.equal(p.retrying, 5);
  assert.equal(p.progressPercent, 40);
});

test("'checked' is not 'confirmed': confirmed director data is a separate figure and can never exceed what was checked", () => {
  const p = computeDirectorProgress(input({ resolved: 1_000, confirmedEligible: 800 }));
  assert.equal(p.processed, 1_000);
  assert.equal(p.confirmedEligible, 800);
  assert.equal(computeDirectorProgress(input({ resolved: 1_000, confirmedEligible: 5_000 })).confirmedEligible, 1_000);
});

test("nothing eligible is 'nothing to process', not 'complete'; everything checked is complete; no division by zero", () => {
  const none = computeDirectorProgress(input({ eligibleTotal: 0, resolved: 0 }));
  assert.equal(none.progressPercent, 0);
  assert.equal(none.status.state, "no_companies");
  assert.equal(none.eta.state, "none");
  const v = toDirectorProgressView(none);
  assert.deepEqual([v.status.label, v.eta, v.rate], ["Nothing to process", "—", "—"]);
  const done = computeDirectorProgress(input({ eligibleTotal: 50, resolved: 50 }));
  assert.equal(done.remaining, 0);
  assert.equal(done.eta.state, "complete");
  assert.equal(done.status.state, "complete");
  assert.equal(done.progressPercent, 100);
});

// ---- insufficient history: never an invented date -----------------------------------------------------------------------------------
test("no processing history at all: 'Calculating estimate', no date, no rate", () => {
  const p = computeDirectorProgress(input());
  assert.deepEqual(p.eta, { state: "calculating", days: null, date: null });
  assert.equal(p.pace.perDay, null);
  const v = toDirectorProgressView(p);
  assert.equal(v.eta, "Calculating estimate");
  assert.equal(v.rate, "Calculating estimate");
});

test("one or two complete days of history is still not enough; three is", () => {
  assert.equal(computeDirectorProgress(input({ daily: [d(1, 30_000)] })).eta.state, "calculating");
  assert.equal(computeDirectorProgress(input({ daily: [d(2, 30_000), d(1, 30_000)] })).eta.state, "calculating");
  assert.equal(computeDirectorProgress(input({ daily: THREE_STEADY_DAYS })).eta.state, "estimate");
});

test("today's partial day is never counted (it would understate the pace every morning)", () => {
  const withToday = computeDirectorProgress(input({ daily: [...THREE_STEADY_DAYS, d(0, 999_999)] }));
  assert.equal(withToday.pace.perDay, computeDirectorProgress(input({ daily: THREE_STEADY_DAYS })).pace.perDay);
  assert.equal(computeDirectorProgress(input({ daily: [d(0, 500_000)] })).eta.state, "calculating", "only today: no complete day yet");
});

test("activity older than the 14-day lookback is ignored", () => {
  assert.equal(computeDirectorProgress(input({ daily: [d(20, 50_000), d(19, 50_000), d(18, 50_000)] })).eta.state, "calculating");
});

// ---- the estimate itself ------------------------------------------------------------------------------------------------------------
test("estimate: automatic backlog / average daily successes over the window, counted in whole days from today", () => {
  const p = computeDirectorProgress(input({ daily: THREE_STEADY_DAYS }));
  assert.equal(p.pace.perDay, 30_000);
  assert.equal(p.pace.windowDays, 3);
  assert.equal(p.eta.state, "estimate");
  assert.equal(p.eta.days, Math.ceil(p.remaining / 30_000));
  assert.equal(p.eta.date, addDays(TODAY, p.eta.days!));
});

test("only the last 7 complete days set the pace: an old fast week does not flatter today's slow one", () => {
  const fast = [14, 13, 12, 11, 10, 9, 8].map((b) => d(b, 100_000));
  const slow = [7, 6, 5, 4, 3, 2, 1].map((b) => d(b, 10_000));
  assert.equal(computeDirectorProgress(input({ daily: [...fast, ...slow] })).pace.perDay, 10_000);
});

test("idle days after the first active day count as zero, so downtime lowers the pace (and delays the estimate)", () => {
  const p = computeDirectorProgress(input({ daily: [d(7, 21_000), d(6, 21_000), d(5, 21_000)] }));
  assert.equal(p.pace.perDay, (21_000 * 3) / 7);
  const steady = computeDirectorProgress(input({ daily: [7, 6, 5, 4, 3, 2, 1].map((b) => d(b, 21_000)) }));
  assert.ok(p.eta.days! > steady.eta.days!, "downtime makes the estimate later");
});

test("a window that started recently averages over the days since the first activity, not over a full empty week", () => {
  assert.equal(computeDirectorProgress(input({ daily: [4, 3, 2, 1].map((b) => d(b, 12_000)) })).pace.perDay, 12_000);
});

test("no successful processing in the last 7 days although it ran before: 'No recent processing', never a date", () => {
  const p = computeDirectorProgress(input({ daily: [14, 13, 12, 11, 10].map((b) => d(b, 40_000)) }));
  assert.equal(p.eta.state, "no_recent_processing");
  assert.equal(p.eta.date, null);
  assert.equal(formatEta(p.eta), "No recent processing");
});

// ---- failures, retries, parked companies, daily limit -------------------------------------------------------------------------------
test("failures and parked companies lower the pace: only successful crawl completions count", () => {
  const clean = computeDirectorProgress(input({ daily: THREE_STEADY_DAYS }));
  const failing = computeDirectorProgress(input({ daily: [3, 2, 1].map((b) => d(b, 30_000, { failures: 3_000, parked: 1_000 })) }));
  assert.equal(failing.pace.perDay, 26_000);
  assert.ok(failing.eta.days! > clean.eta.days!);
});

test("the estimate covers the AUTOMATIC backlog: parked companies need a manual retry, so they are not waited for", () => {
  const withParked = computeDirectorProgress(input({ daily: THREE_STEADY_DAYS, eligibleTotal: 1_000_000, resolved: 100_000, parked: 60_000 }));
  assert.equal(withParked.remaining, 900_000, "parked companies are still part of 'remaining'");
  assert.equal(withParked.eta.days, Math.ceil((900_000 - 60_000) / 30_000));
  assert.match(toDirectorProgressView(withParked).etaSub ?? "", /excluding 60,000 parked/);
  // retrying companies ARE waited for: they come back automatically
  const retrying = computeDirectorProgress(input({ daily: THREE_STEADY_DAYS, eligibleTotal: 1_000_000, resolved: 100_000, retrying: 60_000 }));
  assert.equal(retrying.eta.days, Math.ceil(900_000 / 30_000));
});

test("only parked companies left: 'Waiting for a manual retry', never a date", () => {
  const p = computeDirectorProgress(input({ daily: THREE_STEADY_DAYS, eligibleTotal: 100, resolved: 90, parked: 10 }));
  assert.equal(p.eta.state, "manual_retry");
  assert.equal(formatEta(p.eta), "Waiting for a manual retry");
});

test("the daily request cap bounds the pace: a pace the cap does not allow is never promised", () => {
  const daily = [3, 2, 1].map((b) => d(b, 50_000));
  const capped = computeDirectorProgress(input({ daily, dailyRequestCap: 20_000 }));
  assert.equal(capped.pace.perDay, 20_000);
  assert.equal(capped.pace.capLimited, true);
  assert.equal(toDirectorProgressView(capped).rateNote, "Limited by the daily cap");
  assert.equal(computeDirectorProgress(input({ daily, dailyRequestCap: 0 })).pace.perDay, 50_000, "0 means no cap");
  assert.equal(computeDirectorProgress(input({ daily, dailyRequestCap: null })).pace.perDay, 50_000, "no recorded cap: no clamp");
  const generous = computeDirectorProgress(input({ daily, dailyRequestCap: 500_000 }));
  assert.equal(generous.pace.perDay, 50_000, "a generous cap never raises the pace above what really happened");
  assert.equal(generous.pace.capLimited, false);
});

test("companies with no officer data cost two requests, so the cap allows fewer of them per day", () => {
  const daily = [3, 2, 1].map((b) => d(b, 20_000, { processed: 20_000, requests: 40_000 }));
  assert.equal(computeDirectorProgress(input({ daily, dailyRequestCap: 30_000 })).pace.perDay, 15_000);
});

test("the estimate follows the work: a smaller backlog finishes sooner, and a faster pace brings the date forward", () => {
  const before = computeDirectorProgress(input({ daily: THREE_STEADY_DAYS }));
  const after = computeDirectorProgress(input({ daily: THREE_STEADY_DAYS, resolved: 463_905 + 300_000 }));
  assert.ok(after.remaining < before.remaining && after.eta.days! < before.eta.days! && after.eta.date! < before.eta.date!);
  assert.ok(computeDirectorProgress(input({ daily: [3, 2, 1].map((b) => d(b, 60_000)) })).eta.days! < before.eta.days!);
});

// ---- current processing status ------------------------------------------------------------------------------------------------------
test("status: processing, between runs, paused by the daily limit, not running, not started, complete", () => {
  const st = (over: Partial<DirectorProgressInput>) => computeDirectorProgress(input(over)).status.state;
  assert.equal(st({}), "processing", "a running worker with a fresh heartbeat");
  assert.equal(st({ latestRun: { ...RUNNING, heartbeatAt: new Date("2026-11-15T14:00:00Z") }, lastProcessedAt: new Date("2026-11-15T13:58:00Z") }), "between_runs", "stale heartbeat but active minutes ago");
  assert.equal(st({ latestRun: { status: "success", heartbeatAt: new Date("2026-11-15T09:00:00Z"), finishedAt: new Date("2026-11-15T09:00:00Z"), stopReason: "daily_cap" }, lastProcessedAt: new Date("2026-11-15T09:00:00Z") }), "paused_daily_cap");
  assert.equal(st({ latestRun: { status: "success", heartbeatAt: new Date("2026-11-14T09:00:00Z"), finishedAt: new Date("2026-11-14T09:00:00Z"), stopReason: "daily_cap" }, lastProcessedAt: new Date("2026-11-14T09:00:00Z") }), "idle", "yesterday's daily-limit stop does not pause today");
  assert.equal(st({ latestRun: { status: "stalled", heartbeatAt: new Date("2026-11-15T08:00:00Z"), finishedAt: null, stopReason: null }, lastProcessedAt: new Date("2026-11-15T08:00:00Z") }), "idle");
  assert.equal(st({ latestRun: null, lastProcessedAt: null }), "not_started");
  assert.equal(st({ eligibleTotal: 10, resolved: 10 }), "complete");
});

// ---- wording ------------------------------------------------------------------------------------------------------------------------
test("durations are coarse on purpose and dates are shown with them", () => {
  assert.equal(formatDuration(1), "1 day");
  assert.equal(formatDuration(9), "9 days");
  assert.equal(formatDuration(21), "3 weeks");
  assert.equal(formatDuration(205), "7 months");
  assert.equal(formatDuration(900), "2.5 years");
  assert.match(formatEta(computeDirectorProgress(input({ daily: THREE_STEADY_DAYS })).eta), /^6 months · \d{2} [A-Z][a-z]{2} 2027$/);
});

test("percentages keep small shares honest and read the same everywhere", () => {
  assert.equal(formatPercent(0), "0%");
  assert.equal(formatPercent(0.004), "<0.01%");
  assert.equal(formatPercent(8.1678), "8.17%");
  assert.equal(formatPercent(63.456), "63.5%");
  assert.equal(formatPercent(100), "100.0%");
});

test("the view carries ready-made text: grouped numbers, UTC times, status wording, retry and parked lines", () => {
  const v = toDirectorProgressView(computeDirectorProgress(input({ daily: THREE_STEADY_DAYS, parked: 7, retrying: 12 })));
  assert.equal(v.eligible, "5,679,706");
  assert.equal(v.checked, "463,905");
  assert.equal(v.remaining, "5,215,801");
  assert.equal(v.today, "18,223");
  assert.equal(v.percentText, "8.17%");
  assert.equal(v.rate, "30,000 a day");
  assert.equal(v.rateNote, "Last 3 days");
  assert.equal(v.lastUpdate, "15 Nov 2026, 14:03 UTC");
  assert.equal(v.asOfText, "15 Nov 2026, 14:05 UTC");
  assert.equal(v.status.label, "Processing now");
  assert.deepEqual(v.attention, ["12 awaiting an automatic retry", "7 parked after repeated failures (need a manual retry)"]);
  assert.equal(toDirectorProgressView(computeDirectorProgress(input({ lastProcessedAt: null, latestRun: null }))).lastUpdate, "No processing recorded yet");
  assert.equal(formatDateTimeUtc(null), "—");
});

// ---- reading the worker's run records ------------------------------------------------------------------------------------------------
test("run records are summed per UTC day by start time; unreadable stats contribute nothing", () => {
  const s = (o: object) => JSON.stringify(o);
  const days = aggregateRuns([
    { startedAt: new Date("2026-11-14T23:30:00Z"), statsJson: s({ crawled: 100, processed: 110, failures: 2, parked: 1, requests: 112 }) },
    { startedAt: new Date("2026-11-15T00:10:00Z"), statsJson: s({ crawled: 50, processed: 50, requests: 50 }) },
    { startedAt: new Date("2026-11-15T09:00:00Z"), statsJson: "{not json" },
    { startedAt: new Date("2026-11-15T10:00:00Z"), statsJson: null },
    { startedAt: new Date("2026-11-15T11:00:00Z"), statsJson: s({ crawled: "many", failures: -4, requests: NaN }) },
  ]);
  assert.deepEqual(days, [
    { day: "2026-11-14", crawled: 100, processed: 110, failures: 2, parked: 1, requests: 112, dissolved: 0 },
    { day: "2026-11-15", crawled: 50, processed: 50, failures: 0, parked: 0, requests: 50, dissolved: 0 },
  ]);
});

test("the cap and the stop reason are read from the worker's own record of the run", () => {
  const s = (o: object) => ({ statsJson: JSON.stringify(o) });
  assert.equal(latestRecordedCap([s({ dailyRequestCap: 100_000 }), s({ dailyRequestCap: 40_000 })]), 40_000);
  assert.equal(latestRecordedCap([s({ dailyRequestCap: 100_000 }), s({ crawled: 5 }), { statsJson: "oops" }]), 100_000, "skips runs that recorded none");
  assert.equal(latestRecordedCap([s({ dailyRequestCap: 0 })]), 0);
  assert.equal(latestRecordedCap([{ statsJson: null }]), null);
  assert.equal(latestRecordedCap([]), null);
  assert.equal(stopReasonOf(JSON.stringify({ stopReason: "daily_cap" })), "daily_cap");
  assert.equal(stopReasonOf("nope"), null);
  assert.equal(stopReasonOf(null), null);
});

// ---- the two percentages, the confirmed count, and the eligibility rule -----------------------------------------------------------------
test("two different percentages with two exact names: processing progress (checked / eligible) and confirmed coverage (confirmed / all UK)", () => {
  assert.equal(LABEL_PROGRESS, "Director Processing Progress");
  assert.equal(LABEL_COVERAGE, "Confirmed Director Data Coverage");
  const p = computeDirectorProgress(input());
  assert.equal(p.progressPercent, (463_905 / 5_679_706) * 100);
  assert.equal(p.coveragePercent, (453_208 / 14_034_565) * 100);
  assert.notEqual(formatPercent(p.progressPercent), formatPercent(p.coveragePercent), "they are different measures with different denominators");
  const v = toDirectorProgressView(p);
  assert.equal(v.percentText, "8.17%", "processing progress");
  assert.equal(v.coverage.percentText, "3.23%", "confirmed coverage");
});

test("the confirmed count shown on the card splits into 'being processed' + 'dissolved, fetched on demand' and the two always add up to it", () => {
  const p = computeDirectorProgress(input());
  assert.equal(p.confirmedAll, 453_208);
  assert.equal(p.confirmedEligible, 452_000);
  assert.equal(p.confirmedDissolved, 1_208, "the dissolved companies that were fetched on demand and have confirmed directors");
  assert.equal(p.confirmedEligible + p.confirmedDissolved, p.confirmedAll);
  const v = toDirectorProgressView(p);
  assert.deepEqual([v.coverage.confirmed, v.coverage.totalUk], ["453,208", "14,034,565"]);
  for (const [all, inside] of [[10, 10], [10, 0], [0, 0], [999_999_999, 5], [5, 9]]) {
    const q = computeDirectorProgress(input({ confirmedAll: all, confirmedEligible: inside }));
    assert.equal(q.confirmedEligible + q.confirmedDissolved, q.confirmedAll, `${all}/${inside}`);
    assert.ok(q.confirmedDissolved >= 0 && q.confirmedAll <= q.totalUk);
  }
});

test("a checked company is not a confirmed one: empty officer lists and 'no data at Companies House' are checked but never counted as confirmed", () => {
  const p = computeDirectorProgress(input({ resolved: 1_000, confirmedEligible: 800, confirmedAll: 805 }));
  assert.equal(p.processed, 1_000);
  assert.equal(p.confirmedEligible, 800);
  assert.ok(p.confirmedEligible <= p.processed);
});

test("the officer worker's eligibility rule is still the one this panel counts (tripwire: change the crawl rule and this must be updated)", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../src/lib/companies-house/officerQueue.ts"), "utf8");
  // crawlPage: officersCoverage 'none', not seed, and the status of each phase: LIVE lane = active first, then every other live status;
  // DISSOLVED lane = dissolved. Together that is EVERY status.
  assert.match(src, /c\."officersCoverage" = 'none' AND c\."source" <> 'seed' AND \$\{statusCond\}/);
  assert.match(src, /phase === "active" \? `c\."status" = 'active'` : phase === "dissolved" \? `c\."status" = 'dissolved'` : `c\."status" <> 'active' AND c\."status" <> 'dissolved'`/);
  // a dissolved company's officer list does not change: it is never queued for a TTL or "unavailable" re-check
  assert.equal((src.match(/c\."officersFetchedAt" < \$\{utc\(1\)\} AND c\."status" <> 'dissolved'/g) ?? []).length, 2);
  // ...so the panel's ELIGIBLE rule is "every real company", counted from the rows.
  const loader = fs.readFileSync(path.resolve(__dirname, "../../src/lib/data/director-progress.ts"), "utf8");
  assert.match(loader, /SELECT count\(\*\) AS eligible,/);
  assert.match(loader, /WHERE c\."source" <> 'seed'`\);/);
});

// ---- daily API usage: requests, never companies --------------------------------------------------------------------------------------
test("API usage counts today's Companies House REQUESTS against the cap, not processed companies", () => {
  const p = computeDirectorProgress(input({ processedToday: 18_223, daily: [d(0, 18_223, { requests: 25_832 })] }));
  assert.equal(p.api.state, "ok");
  assert.equal(p.api.usedToday, 25_832, "requests, not the 18,223 companies processed today");
  assert.equal(p.api.cap, 100_000);
  assert.equal(p.api.remaining, 74_168);
  const v = toDirectorProgressView(p).api;
  assert.deepEqual([v.used, v.cap, v.remaining, v.warn], ["25,832", "100,000", "74,168", false]);
});

test("API usage: over-cap clamps remaining at 0 and warns; no cap and unknown cap are reported, not invented", () => {
  const over = computeDirectorProgress(input({ daily: [d(0, 1, { requests: 100_050 })] }));
  assert.equal(over.api.remaining, 0);
  assert.equal(over.api.percentUsed, 100);
  assert.equal(toDirectorProgressView(over).api.warn, true);
  const none = computeDirectorProgress(input({ dailyRequestCap: 0, daily: [d(0, 1, { requests: 5 })] }));
  assert.deepEqual([none.api.state, none.api.remaining, toDirectorProgressView(none).api.cap], ["no_cap", null, null]);
  const unknown = computeDirectorProgress(input({ dailyRequestCap: null }));
  assert.deepEqual([unknown.api.state, unknown.api.remaining], ["unknown", null]);
  const idle = computeDirectorProgress(input({ daily: [] }));
  assert.equal(idle.api.usedToday, 0);
  assert.equal(idle.api.remaining, 100_000);
});

// ---- director APPOINTMENTS: an actual count today, an estimate for the rest ----------------------------------------------------------
const ASOF = new Date("2026-11-15T20:00:00Z");
// mean 2, variance 2 (values 0,2,4 evenly): n=300, sum=600, sumsq=300*(var*(n-1)/n + mean^2)
const stratum = (sg: string, ty: string, n: number, mean: number, variance: number, u: number) => ({ sg, ty, n, s: n * mean, ss: variance * (n - 1) + n * mean * mean, u });

test("the appointment estimate applies each stratum's mean to its unchecked companies and sums them", () => {
  const e = estimateRemainingAppointments([stratum("active", "ltd", 300, 2, 4, 1_000_000), stratum("active", "llp", 300, 1, 1, 500_000)], ASOF)!;
  assert.equal(e.total, 2_500_000);
  assert.equal(e.checkedCompanies, 600);
  assert.equal(e.uncheckedCompanies, 1_500_000);
  assert.equal(e.meanPerCompany, 1.5);
  // SE = sqrt(1e6^2*4/300 + 5e5^2*1/300); range = +/-1.96 SE
  const se = Math.sqrt((1e12 * 4) / 300 + (25e10 * 1) / 300);
  assert.ok(Math.abs(e.high - e.total - 1.96 * se) < 2 && Math.abs(e.total - e.low - 1.96 * se) < 2);
  assert.ok(e.low < e.total && e.total < e.high);
  assert.equal(e.asOf, ASOF.toISOString());
});

test("thin strata (under 30 checked companies) are pooled instead of producing a wild mean; nothing to sample = no estimate, never a guess", () => {
  // two thin 'ltd' strata (10 checked each, means 0 and 100) pool into one stratum of 20 with mean 50, not 0 and 100 each
  const e = estimateRemainingAppointments([stratum("active", "ltd", 300, 1.5, 2, 1_000), stratum("active", "ltd", 10, 0, 0, 100), stratum("active", "ltd", 10, 100, 0, 100)], ASOF)!;
  assert.equal(e.total, Math.round(1_000 * 1.5 + 100 * 50 + 100 * 50), "the two thin strata share the pooled mean (only 20 companies: pooled up to status group)");
  assert.equal(estimateRemainingAppointments([], ASOF), null);
  assert.equal(estimateRemainingAppointments([stratum("active", "ltd", 1, 2, 0, 5)], ASOF), null);
  assert.equal(estimateRemainingAppointments([stratum("active", "ltd", 300, 1.5, 2, 0)], ASOF)!.total, 0, "no unchecked companies = nothing remaining");
});

test("appointments in the progress object: today is an actual count or null (never invented); the estimate is carried separately", () => {
  assert.equal(computeDirectorProgress(input()).appointments.importedToday, null, "not measured = null, not 0");
  assert.equal(computeDirectorProgress(input({ appointmentsToday: 0 })).appointments.importedToday, 0);
  assert.equal(computeDirectorProgress(input({ appointmentsToday: 47_370 })).appointments.importedToday, 47_370);
  assert.equal(computeDirectorProgress(input({ appointmentsToday: -5 })).appointments.importedToday, 0);
  assert.equal(computeDirectorProgress(input()).appointments.estimate, null);
  // appointments are not companies: they never touch the company figures
  const a = computeDirectorProgress(input({ appointmentsToday: 99_999 }));
  assert.equal(a.processedToday, 18_223);
  assert.equal(a.remaining, 5_679_706 - 463_905);
});

test("the view words the estimate as an estimate with its range, and the actual count as a plain number", () => {
  const e = estimateRemainingAppointments([stratum("active", "ltd", 475_000, 1.5355, 3.8, 5_203_000)], ASOF)!;
  const v = toDirectorProgressView(computeDirectorProgress(input({ appointmentsToday: 47_370, appointmentEstimate: e }))).appts;
  assert.equal(v.today, "47,370");
  assert.match(v.estimate ?? "", /^[0-9]\.[0-9]{2}M$/);
  assert.match(v.range ?? "", /^[0-9]\.[0-9]{2}M–[0-9]\.[0-9]{2}M$/);
  assert.match(v.estimateTitle ?? "", /^Estimate, not an exact count: about [0-9.]+M director and LLP-member appointment records still to import \(range [0-9.]+M–[0-9.]+M\), of which about .* current and .* historical .*sampling error only\. Appointments, not unique people\. Calculated 15 Nov 2026, 20:00 UTC\.$/);
  const none = toDirectorProgressView(computeDirectorProgress(input())).appts;
  assert.deepEqual([none.today, none.estimate, none.range, none.estimateTitle], [null, null, null, null]);
  assert.deepEqual([formatCompact(7_943_169), formatCompact(812_400), formatCompact(9_500), formatCompact(0)], ["7.94M", "812K", "9,500", "0"]);
});

test("estimate status in the view: ready carries the calculation time, calculating and unavailable carry no number", () => {
  const e = estimateRemainingAppointments([stratum("active", "ltd", 475_000, 1.5355, 3.8, 5_203_000)], ASOF)!;
  const ready = toDirectorProgressView(computeDirectorProgress(input({ appointmentEstimate: e }))).appts;
  assert.deepEqual([ready.state, ready.calculatedAt], ["ready", "15 Nov 2026, 20:00 UTC"]);
  const calc = toDirectorProgressView(computeDirectorProgress(input({ appointmentEstimateStatus: "calculating" }))).appts;
  assert.deepEqual([calc.state, calc.estimate, calc.range, calc.calculatedAt], ["calculating", null, null, null]);
  const none = toDirectorProgressView(computeDirectorProgress(input({ appointmentEstimateStatus: "unavailable" }))).appts;
  assert.deepEqual([none.state, none.estimate], ["unavailable", null]);
  // an estimate always wins over a stale status: a number is never shown as 'calculating'
  assert.equal(computeDirectorProgress(input({ appointmentEstimate: e, appointmentEstimateStatus: "calculating" })).appointments.estimateStatus, "ready");
});

// ---- ALL statuses: dissolved companies are part of the population, estimated by their own strata -------------------------------------------
import { estimateAppointmentSplit, estimateDissolvedFromSample, formatApprox, type SplitStratum } from "@/lib/data/director-progress-calc";
import { loadOfficerConfig } from "@/lib/companies-house/officerQueue";

const split = (sg: string, dy: number | undefined, n: number, u: number, cur: number, hist: number): SplitStratum => ({
  sg, ty: "ltd", yr: 2015, dm: false, dy, n, u,
  v: { cur: { s: n * cur, ss: n * cur * cur + n }, hist: { s: n * hist, ss: n * hist * hist + n }, all: { s: n * (cur + hist), ss: n * (cur + hist) * (cur + hist) + n } },
});

// A sampled stratum: n resolved companies with mean m records and sample variance v.
const ds = (year: number, n: number, m: number, v = 0) => ({ year, n, sum: n * m, sumSq: n * m * m + (n - 1) * v });

test("the estimate covers every status: live strata use their own means, the dissolved part comes ONLY from the random sample, weighted by each year's population", () => {
  const rows = [split("active", 0, 1_000, 100_000, 1.5, 0.5), split("dissolved", 2012, 40, 30_000, 0, 5), split("dissolved", 2024, 6_000, 40_000, 0, 1.2), split("other", 0, 100, 1_000, 1, 1)];
  const e = estimateAppointmentSplit(rows, ASOF, [ds(2012, 150, 4, 4), ds(2024, 150, 1.1, 0.2)])!;
  assert.equal(e.current.total, Math.round(100_000 * 1.5 + 1_000 * 1), "dissolved companies contribute no CURRENT appointments");
  // each dissolved year is weighted by its own unchecked population: 30,000 x 4 + 40,000 x 1.1 (NOT by the 6,000 on-demand checks, whose mean of 1.2 is ignored)
  assert.equal(e.historical.total, Math.round(100_000 * 0.5 + 30_000 * 4 + 40_000 * 1.1 + 1_000 * 1));
  assert.equal(e.total, e.current.total + e.historical.total);
  assert.ok(e.low < e.total && e.total < e.high);
  assert.equal(e.uncheckedCompanies, 171_000);
  assert.equal(e.uncoveredCompanies, 0);
  assert.equal(e.provisional, false, "every unchecked dissolved year has an adequate random sample");
  // estimated is not checked: the two numbers are kept apart
  assert.equal(e.dissolvedChecked, 6_040, "individually checked dissolved companies");
  assert.equal(e.dissolvedSampled, 300);
  assert.equal(e.dissolvedEstimated, 70_000, "unchecked dissolved companies whose records are estimated from the sample");
});

test("dissolved companies are never estimated from the companies somebody happened to check: without the random sample they are left out and reported", () => {
  const e = estimateAppointmentSplit([split("active", 0, 300, 1_000, 1.5, 0), split("dissolved", 2018, 100_000, 10_000, 0, 1.2)], ASOF)!;
  assert.equal(e.provisional, true);
  assert.equal(e.historical.total, 0, "nothing is extrapolated from 100,000 on-demand checks");
  assert.equal(e.uncoveredCompanies, 10_000);
  assert.equal(e.dissolvedChecked, 100_000);
  assert.equal(e.imported, 300 * 1.5 + 100_000 * 1.2, "their already-imported records are still counted exactly");
});

test("a dissolved year needs 30 resolved sampled companies: with fewer it is NOT covered and nothing is guessed or borrowed from another year", () => {
  const rows = [split("dissolved", 2012, 50, 1_000, 0, 0), split("dissolved", 2024, 50, 7_000, 0, 0)];
  const e = estimateAppointmentSplit(rows, ASOF, [ds(2012, 60, 3, 1), ds(2024, 29, 0.1, 0)])!;
  assert.equal(e.historical.total, 1_000 * 3, "only the covered 2012 stratum is estimated; 2024 does not take 2012's mean");
  assert.equal(e.uncoveredCompanies, 7_000);
  assert.equal(e.dissolvedEstimated, 1_000);
  assert.equal(e.provisional, true, "an uncovered year keeps the national estimate incomplete");
  const e30 = estimateAppointmentSplit(rows, ASOF, [ds(2012, 60, 3, 1), ds(2024, 30, 0.1, 0)])!;
  assert.equal(e30.provisional, false);
  assert.equal(e30.historical.total, 1_000 * 3 + 7_000 * 0.1);
});

test("dissolved stratum maths: weights = unchecked population, unavailable companies count as 0, the interval uses the finite-population correction and the variances add", () => {
  // 100 sampled companies: 60 with 2 records, 40 unavailable (0): mean 1.2, variance = 0.24*100/99
  const sum = 120, sumSq = 240;
  const r = estimateDissolvedFromSample(new Map([[2015, 10_000]]), [{ year: 2015, n: 100, sum, sumSq }]);
  assert.equal(Math.round(r.total), 12_000);
  const s2 = (sumSq - 100 * 1.2 * 1.2) / 99;
  const expectedVar = 10_000 * 10_000 * (10_000 / 10_100) * (s2 / 100);
  assert.ok(Math.abs(r.variance - expectedVar) < 1e-6);
  const st = r.strata[0];
  assert.ok(Math.abs(st.se - Math.sqrt(expectedVar)) < 1e-9);
  assert.equal(st.low, Math.round(12_000 - 1.96 * st.se));
  // two years: totals add, variances add, a bigger population counts for proportionally more
  const two = estimateDissolvedFromSample(new Map([[2015, 10_000], [2020, 30_000]]), [{ year: 2015, n: 100, sum, sumSq }, { year: 2020, n: 100, sum: 200, sumSq: 500 }]);
  assert.equal(Math.round(two.total), 12_000 + 60_000);
  assert.ok(two.variance > r.variance);
  // a fully sampled year (nothing unchecked) contributes nothing and cannot be 'uncovered'
  const done = estimateDissolvedFromSample(new Map([[2015, 0]]), [{ year: 2015, n: 5, sum: 5, sumSq: 5 }]);
  assert.deepEqual([done.total, done.uncovered, done.strata[0].covered], [0, 0, true]);
});

test("status groups and checked outcomes are carried only when they add up to the population", () => {
  const groups = { active: { total: 5_559_903, checked: 480_000 }, dissolved: { total: 8_354_859, checked: 1_500 }, other: { total: 120_220, checked: 200 } };
  const p = computeDirectorProgress(input({ eligibleTotal: 14_034_982, resolved: 481_700, groups, outcomes: { withDirectors: 470_000, noDirectors: 11_000, unavailable: 700 } }));
  assert.equal(p.groups?.dissolved.remaining, 8_353_359);
  assert.equal(p.remaining, 14_034_982 - 481_700, "remaining = eligible (every status) - checked");
  const v = toDirectorProgressView(p);
  assert.deepEqual(v.groups?.map((g) => g.label), ["Active", "Dissolved", "Other non-active"]);
  assert.equal(v.outcomes?.withDirectors, "470,000");
  assert.equal(computeDirectorProgress(input({ eligibleTotal: 14_034_982, groups: { ...groups, other: { total: 1, checked: 0 } } })).groups, null, "groups that do not add up to the population are not shown");
});

test("appointments written today are split into current and historical, and the total is their sum", () => {
  const v = toDirectorProgressView(computeDirectorProgress(input({ appointmentsToday: 12_000, appointmentsTodayHistorical: 9_500 }))).appts;
  assert.deepEqual([v.today, v.todayCurrent, v.todayHistorical], ["21,500", "12,000", "9,500"]);
});

test("OFFICER_CRAWL_DISSOLVED_PERCENT: default 40, 0 switches the dissolved lane off, 100 is the maximum, nonsense falls back", () => {
  assert.equal(loadOfficerConfig({} as unknown as NodeJS.ProcessEnv).crawlDissolvedPercent, 40);
  assert.equal(loadOfficerConfig({ OFFICER_CRAWL_DISSOLVED_PERCENT: "0" } as unknown as NodeJS.ProcessEnv).crawlDissolvedPercent, 0);
  assert.equal(loadOfficerConfig({ OFFICER_CRAWL_DISSOLVED_PERCENT: "250" } as unknown as NodeJS.ProcessEnv).crawlDissolvedPercent, 100);
  assert.equal(loadOfficerConfig({ OFFICER_CRAWL_DISSOLVED_PERCENT: "-5" } as unknown as NodeJS.ProcessEnv).crawlDissolvedPercent, 0);
  assert.equal(loadOfficerConfig({ OFFICER_CRAWL_DISSOLVED_PERCENT: "abc" } as unknown as NodeJS.ProcessEnv).crawlDissolvedPercent, 40);
  assert.equal(loadOfficerConfig({ OFFICER_DAILY_REQUEST_CAP: "100000" } as unknown as NodeJS.ProcessEnv).dailyRequestCap, 100_000, "the share never changes the request cap");
});

test("a partial estimate (companies without a usable sample are left out) is shown as 'N+', never as a complete total", () => {
  const partial = estimateAppointmentSplit([split("active", 0, 300, 1_000, 1.5, 0), split("dissolved", 2012, 5, 7_000, 0, 1)], ASOF)!;
  assert.ok(partial.uncoveredCompanies > 0);
  const v = toDirectorProgressView(computeDirectorProgress(input({ appointmentEstimate: partial }))).appts;
  assert.equal(v.partial, true);
  assert.match(v.note ?? "", /excludes 7,000 companies not yet sampled/);
  const whole = estimateAppointmentSplit([split("active", 0, 300, 1_000, 1.5, 0)], ASOF)!;
  assert.equal(toDirectorProgressView(computeDirectorProgress(input({ appointmentEstimate: whole }))).appts.partial, false);
});

// ---- the three-figure summary: estimated director data, last update, daily API requests ------------------------------------------------
import { buildDirectorSummaryView } from "@/lib/data/director-summary-view";

test("summary: IMPORTED is the actual count; an ALL-status total exists only with a defensible sample, never as a live-only figure", () => {
  const e = estimateAppointmentSplit([split("active", 0, 300, 1_000, 1.5, 0.5), split("dissolved", 2012, 5, 7_000, 0, 1)], ASOF)!;
  assert.equal(e.provisional, true);
  const imported = { current: 450, historical: 155 };
  const v = buildDirectorSummaryView({ now: NOW, imported, estimate: e, estimateStatus: "ready", lastUpdateAt: new Date("2026-11-16T10:45:12Z"), requestsToday: 18_968, cap: 100_000 });
  assert.equal(v.imported.value, "605", "the exact count, grouped, never abbreviated or estimated");
  assert.equal(v.imported.total, 605);
  assert.equal(e.total, 1_000 * 2, "the 7,000 dissolved companies contribute nothing to the live estimate");
  // the dissolved companies have no representative sample: NO total and NO remaining figure; the live-only number is never shown
  assert.deepEqual([v.estimate.state, v.estimate.value, v.estimate.remaining, v.estimate.range, v.estimate.status], ["unavailable", null, null, null, "Not yet available"]);
  assert.match(v.estimate.title ?? "", /No total is shown: an estimate across ALL UK companies needs a representative sample of dissolved companies from every dissolution year/);
  assert.ok(!JSON.stringify(v).includes(formatCompact(605 + e.total)), "the live-only total appears nowhere in the view");
  assert.match(v.imported.title ?? "", /Actual count of director and LLP-member appointment records stored in the database/);
  // with every company covered by a sample the total is imported + estimated remaining, and remaining = total - imported
  const whole = estimateAppointmentSplit([split("active", 0, 300, 1_000, 1.5, 0.5)], ASOF)!;
  assert.equal(whole.uncoveredCompanies, 0);
  assert.equal(whole.provisional, false);
  const w = buildDirectorSummaryView({ now: NOW, imported, estimate: whole, estimateStatus: "ready", lastUpdateAt: null, requestsToday: 0, cap: 100_000 });
  assert.equal(w.estimate.state, "ready");
  assert.equal(w.estimate.value, "≈ " + formatApprox(605 + whole.total));
  assert.equal(w.estimate.remaining, formatCompact(whole.total));
  assert.equal(w.estimate.status, null);
  assert.match(w.estimate.title ?? "", /across ALL UK companies, every status/);
  assert.equal(w.lastUpdate.text, "No update recorded yet");
  // while the estimate is being calculated the ACTUAL imported count is still shown, and the total is not invented
  const c = buildDirectorSummaryView({ now: NOW, imported, estimate: null, estimateStatus: "calculating", lastUpdateAt: null, requestsToday: 1, cap: 10 });
  assert.deepEqual([c.imported.value, c.estimate.state, c.estimate.value, c.estimate.status], ["605", "calculating", null, "Calculating…"]);
});

test("summary: the last update is the database timestamp in UTC; API usage is used / limit / remaining, and never invented", () => {
  const imported = { current: 1, historical: 1 };
  const v = buildDirectorSummaryView({ now: NOW, imported, estimate: null, estimateStatus: "calculating", lastUpdateAt: new Date("2026-11-16T10:45:12Z"), requestsToday: 18_968, cap: 100_000 });
  assert.equal(v.lastUpdate.text, "16 Nov 2026, 10:45 UTC");
  assert.equal(v.lastUpdate.iso, "2026-11-16T10:45:12.000Z");
  assert.deepEqual([v.api.state, v.api.used, v.api.cap, v.api.remaining, v.api.warn], ["ok", "18,968", "100,000", "81,032", false]);
  const over = buildDirectorSummaryView({ now: NOW, imported, estimate: null, estimateStatus: "unavailable", lastUpdateAt: null, requestsToday: 100_040, cap: 100_000 });
  assert.deepEqual([over.api.remaining, over.api.warn], ["0", true]);
  const noCap = buildDirectorSummaryView({ now: NOW, imported, estimate: null, estimateStatus: "unavailable", lastUpdateAt: null, requestsToday: 5, cap: 0 });
  assert.deepEqual([noCap.api.state, noCap.api.cap, noCap.api.remaining], ["no_cap", null, null]);
  const unknown = buildDirectorSummaryView({ now: NOW, imported: null, estimate: null, estimateStatus: "unavailable", lastUpdateAt: null, requestsToday: null, cap: null });
  assert.deepEqual([unknown.api.state, unknown.api.used, unknown.imported.value], ["unknown", null, null]);
});

// ---- estimated time to complete: every status, real history, provisional until the dissolved lane has history -----------------------------
import { projectCompletion } from "@/lib/data/director-progress-calc";

test("time to complete = unchecked companies of EVERY status / successful companies per day over complete UTC days; provisional without dissolved history", () => {
  const live = [3, 2, 1].map((b) => d(b, 30_000)); // 30,000 a day, no dissolved companies crawled
  const c = projectCompletion({ now: NOW, daily: live, remaining: 13_500_000, dissolvedRemaining: 8_350_000, parked: 0, cap: 100_000 });
  assert.equal(c.state, "estimate");
  assert.equal(c.days, Math.ceil(13_500_000 / 30_000), "the dissolved companies are part of what is left");
  assert.equal(c.provisional, true, "no dissolved history yet");
  assert.equal(c.dissolvedHistory, 0);
  // with real dissolved history the same pace is NOT provisional
  const mixed = [3, 2, 1].map((b) => d(b, 30_000, { dissolved: 12_000 }));
  const m = projectCompletion({ now: NOW, daily: mixed, remaining: 13_500_000, dissolvedRemaining: 8_350_000, parked: 0, cap: 100_000 });
  assert.equal(m.provisional, false);
  assert.equal(m.dissolvedHistory, 36_000);
  // dissolved companies cost more requests: the daily request cap bounds the pace (here 2 requests per company -> at most 50,000 a day)
  const costly = [3, 2, 1].map((b) => d(b, 90_000, { requests: 180_000, dissolved: 40_000 }));
  const k = projectCompletion({ now: NOW, daily: costly, remaining: 1_000_000, dissolvedRemaining: 1, parked: 0, cap: 100_000 });
  assert.equal(k.capLimited, true);
  assert.equal(k.perDay, 50_000);
  // no dissolved companies left: not provisional whatever the history
  assert.equal(projectCompletion({ now: NOW, daily: live, remaining: 1_000, dissolvedRemaining: 0, parked: 0, cap: null }).provisional, false);
  // never a date without history
  assert.equal(projectCompletion({ now: NOW, daily: [d(1, 30_000)], remaining: 1_000_000, dissolvedRemaining: 0, parked: 0, cap: null }).days, null, "fewer than 3 complete days");
  assert.equal(projectCompletion({ now: NOW, daily: [], remaining: 1_000_000, dissolvedRemaining: 0, parked: 0, cap: null }).state, "calculating");
});

import { formatDateOnly } from "@/lib/data/format";
import { projectRecordCompletion, RECORD_PACE_MIN_DAYS } from "@/lib/data/director-progress-calc";

const rd = (back: number, records: number) => ({ day: day(back), records });
const REM = 30_000_000;

test("completion estimate: remaining RECORDS / records actually imported per day over the last 7 complete UTC days, inactive days counted as zero, today never used", () => {
  // 7 complete days: 100k, 100k, 0 (stopped), 0 (stopped), 80k, 120k, 200k = 600k -> 85,714 a day
  const daily = [rd(7, 100_000), rd(6, 100_000), rd(5, 0), rd(4, 0), rd(3, 80_000), rd(2, 120_000), rd(1, 200_000), rd(0, 9_999_999)];
  const c = projectRecordCompletion({ now: NOW, daily, firstDay: day(30), remaining: REM });
  assert.equal(c.state, "estimate");
  assert.equal(c.recordsInWindow, 600_000, "today's partial day is not part of the pace");
  assert.equal(c.perDay, 600_000 / 7, "downtime days are zero, not skipped");
  assert.equal(c.days, Math.ceil(REM / (600_000 / 7)));
  assert.equal(c.date, addDays(day(0), c.days!));
  // the pace is records, so a bigger company count with the same records changes nothing, and the API limit never enters
  assert.deepEqual(projectRecordCompletion({ now: NOW, daily, firstDay: day(30), remaining: REM }), c);
});

test("completion estimate: no pace is invented: too little history, no recent imports, nothing remaining", () => {
  const some = [rd(1, 50_000), rd(2, 50_000)];
  assert.equal(projectRecordCompletion({ now: NOW, daily: some, firstDay: day(2), remaining: REM }).state, "no_history", "only 2 complete days since the first import");
  assert.equal(projectRecordCompletion({ now: NOW, daily: [rd(0, 5_000)], firstDay: day(0), remaining: REM }).state, "no_history", "the first import is today");
  assert.equal(projectRecordCompletion({ now: NOW, daily: [], firstDay: null, remaining: REM }).state, "no_history");
  assert.equal(RECORD_PACE_MIN_DAYS, 3);
  assert.equal(projectRecordCompletion({ now: NOW, daily: [rd(20, 90_000)], firstDay: day(20), remaining: REM }).state, "no_recent_imports", "imports stopped more than 7 days ago");
  assert.equal(projectRecordCompletion({ now: NOW, daily: some, firstDay: day(30), remaining: 0 }).state, "complete");
  // a short history uses the days that exist: 3 complete days -> a 3-day window, not 7
  const three = projectRecordCompletion({ now: NOW, daily: [rd(1, 30_000), rd(2, 60_000), rd(3, 90_000)], firstDay: day(3), remaining: 1_800_000 });
  assert.deepEqual([three.windowDays, three.perDay, three.days], [3, 60_000, 30]);
});

test("summary view: the time to complete needs the verified all-status estimate; it is a duration, a date and the records-a-day pace; otherwise a plain status", () => {
  const whole = estimateAppointmentSplit([split("active", 0, 300, 1_000, 1.5, 0.5)], ASOF)!;
  const hist = { daily: [1, 2, 3, 4, 5, 6, 7].map((b) => rd(b, 1_000)), firstDay: day(40) };
  const v = buildDirectorSummaryView({ now: NOW, imported: { current: 600, historical: 5 }, estimate: whole, estimateStatus: "ready", recordHistory: hist, lastUpdateAt: null, requestsToday: 0, cap: 100_000 });
  const days = Math.ceil(whole.total / 1_000);
  assert.equal(v.eta.state, "ready");
  assert.equal(v.eta.value, "about " + formatDuration(days));
  assert.equal(v.eta.pace, "1,000 records a day");
  assert.equal(v.eta.date, formatDateOnly(addDays(day(0), days)));
  assert.match(v.eta.note, /estimated total minus imported.*inactive days counted as zero/);
  // not enough history: a status, no date
  const young = buildDirectorSummaryView({ now: NOW, imported: { current: 1, historical: 1 }, estimate: whole, estimateStatus: "ready", recordHistory: { daily: [rd(1, 5)], firstDay: day(1) }, lastUpdateAt: null, requestsToday: 0, cap: 1 });
  assert.deepEqual([young.eta.value, young.eta.date, young.eta.status], [null, null, "Collecting import history"]);
  // no all-status estimate (dissolved companies without a sample): no completion time at all, never the live-only one
  const live = estimateAppointmentSplit([split("active", 0, 300, 1_000, 1.5, 0.5), split("dissolved", 2012, 5, 7_000, 0, 1)], ASOF)!;
  const none = buildDirectorSummaryView({ now: NOW, imported: { current: 1, historical: 1 }, estimate: live, estimateStatus: "ready", recordHistory: hist, lastUpdateAt: null, requestsToday: 0, cap: 1 });
  assert.deepEqual([none.eta.value, none.eta.status], [null, "Not yet available"]);
});

test("the headline estimate is ONE rounded approximate figure; imported-today is the actual count or nothing", () => {
  assert.deepEqual([32_068_850, 32_460_000, 9_960_000, 2_449_000, 850_400, 12_345, 950].map(formatApprox), ["32M", "32M", "10.0M", "2.4M", "850K", "12K", "950"]);
  const e = estimateAppointmentSplit([split("active", 0, 300, 1_000, 1.5, 0.5)], ASOF)!;
  const v = buildDirectorSummaryView({ now: NOW, imported: { current: 600, historical: 5 }, importedToday: 1_234, estimate: e, estimateStatus: "ready", lastUpdateAt: null, requestsToday: 0, cap: 100_000 });
  assert.equal(v.importedToday.value, "1,234");
  assert.match(v.estimate.value ?? "", /^≈ [0-9.,]+[KM]?$/);
  assert.ok((v.estimate.title ?? "").includes("appointment records (not unique people)"));
  assert.equal(buildDirectorSummaryView({ now: NOW, imported: null, importedToday: null, estimate: null, estimateStatus: "calculating", lastUpdateAt: null, requestsToday: null, cap: null }).importedToday.value, null);
});
