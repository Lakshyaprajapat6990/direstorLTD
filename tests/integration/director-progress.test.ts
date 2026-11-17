import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Prisma } from "@prisma/client";
import { BASE, STRONG_PASSWORD, db, login, makeCompany, sessionFor } from "./helpers";
import { addDays, getDirectorProgress, utcDay } from "../../src/lib/data/director-progress";
import { REAL_COMPANIES_WHERE } from "../../src/lib/data/scope";

// The Director Data progress figures against a real PostgreSQL (the scratch database only: helpers.ts refuses anything else) and a local
// stand-in for Companies House (no live API call). The numbers must follow the real Company / OfficerSyncJob / IngestionRun rows, including
// after the real officer worker has run, after a company failed, and after the pipeline parked one. Counts are compared as before/after
// DELTAS so rows left by other suites in the shared scratch database cannot disturb them.

const modes = new Map<string, "gone" | "fail">();
let server: http.Server;
const TAG = String(Date.now() % 1_000_000);
let counter = 0;
const num = () => `DP${TAG}${String(++counter).padStart(3, "0")}`;
const created: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const m = /^\/company\/([^/]+)(\/officers)?$/.exec(new URL(req.url ?? "/", "http://x").pathname);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "X-Ratelimit-Remain": "500", "X-Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 300) });
      res.end(JSON.stringify(body));
    };
    if (!m) return send(404, {});
    const mode = modes.get(m[1]);
    if (mode === "gone") return send(404, {});
    if (mode === "fail") return send(400, { error: "stub failure" });
    return send(200, m[2] ? { items: [], total_results: 0 } : { company_name: m[1], company_number: m[1] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.COMPANIES_HOUSE_API_KEY = "test-rest-key";
  process.env.COMPANIES_HOUSE_REST_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.CH_QUOTA_PACING = "0";
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  await db.officerSyncJob.deleteMany();
});

after(async () => {
  await db.officerSyncJob.deleteMany({ where: { company: { companyNumber: { in: created } } } });
  await db.company.deleteMany({ where: { companyNumber: { in: created } } });
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  server.close();
  await db.$disconnect();
});

const snap = () => getDirectorProgress({ ttlMs: 0 });
async function company(over: Record<string, unknown> = {}) {
  const c = await makeCompany({ companyNumber: num(), ...over });
  created.push(c.companyNumber);
  return c;
}
const todayStart = () => new Date(`${utcDay(new Date())}T00:00:00.000Z`);
const run = (back: number, stats: object, hour = 10) => {
  const today = utcDay(new Date());
  return db.ingestionRun.create({ data: { kind: "officer_backfill", status: "success", startedAt: new Date(`${addDays(today, -back)}T${String(hour).padStart(2, "0")}:00:00Z`), statsJson: JSON.stringify(stats) } });
};

test("eligible, checked, remaining, confirmed, parked, retrying and today's figures are counted from the real rows", async () => {
  const before = await snap();
  const startOfToday = todayStart();
  // Eligible and NOT yet checked: 3 active + 1 in liquidation (the crawl's second phase) + 1 whose job is retrying after a failure.
  for (let i = 0; i < 3; i++) await company({ status: "active" });
  await company({ status: "liquidation" });
  const retrying = await company({ status: "active" });
  await db.officerSyncJob.create({ data: { companyId: retrying.id, priority: 5, reason: "crawl", status: "retry", attempts: 2, lastError: "stub failure", nextAttemptAt: new Date(Date.now() + 3_600_000) } });
  // Eligible, unchecked, and the pipeline gave up on it: parked.
  const parked = await company({ status: "active" });
  await db.officerSyncJob.create({ data: { companyId: parked.id, priority: 5, reason: "crawl", status: "parked", attempts: 6, parkedAt: new Date() } });
  // Eligible and CHECKED: 2 today (one with a director, one with an empty officer list), 1 unavailable earlier, 1 with a director yesterday.
  await company({ officersCoverage: "full", directorCount: 2, officersFetchedAt: new Date() });
  await company({ officersCoverage: "full", directorCount: 0, officersFetchedAt: new Date() });
  await company({ officersCoverage: "unavailable", officersFetchedAt: new Date(startOfToday.getTime() - 3 * 86_400_000) });
  await company({ officersCoverage: "full", directorCount: 1, officersFetchedAt: new Date(startOfToday.getTime() - 3_600_000) });
  // Dissolved companies are part of the population: one still waiting, one already fetched today (on demand) with a director.
  await company({ status: "dissolved" });
  await company({ status: "dissolved", officersCoverage: "full", directorCount: 1, officersFetchedAt: new Date() });
  // NOT eligible: seed rows (synthetic).
  await company({ source: "seed" });
  // The worker's rule has no type condition (the register simply never stores overseas companies), so an unchecked overseas-typed row counts
  // as eligible and remaining, exactly as the crawl would treat it, but it is not part of the UK coverage figures.
  await company({ type: "oversea-company" });

  const after = await snap();
  assert.equal(after.eligibleTotal - before.eligibleTotal, 13, "3 active + 1 liquidation + retrying + parked + the overseas-typed row + 4 checked + the 2 dissolved companies");
  assert.equal(after.processed - before.processed, 5, "4 live checked + the dissolved company fetched on demand");
  assert.equal(after.remaining - before.remaining, 8, "eligible minus checked: the 5 waiting companies, the parked one, the overseas-typed row and the waiting dissolved company");
  assert.equal(after.parked - before.parked, 1);
  assert.equal(after.retrying - before.retrying, 1);
  assert.equal(after.processedToday - before.processedToday, 3, "only companies checked since 00:00 UTC (the dissolved one counts too)");
  // The population by status group, from the same scan, adds up to the total.
  const g = (x: typeof after, k: "active" | "dissolved" | "other") => x.groups![k];
  assert.deepEqual([g(after, "active").total - g(before, "active").total, g(after, "dissolved").total - g(before, "dissolved").total, g(after, "other").total - g(before, "other").total], [10, 2, 1]);
  assert.deepEqual([g(after, "active").checked - g(before, "active").checked, g(after, "dissolved").checked - g(before, "dissolved").checked, g(after, "other").checked - g(before, "other").checked], [4, 1, 0]);
  assert.equal(after.groups!.active.total + after.groups!.dissolved.total + after.groups!.other.total, after.eligibleTotal);
  // How the checked companies came out: with director records, a confirmed empty list, no officer data at Companies House.
  const o = (x: typeof after) => x.outcomes!;
  assert.deepEqual([o(after).withDirectors - o(before).withDirectors, o(after).noDirectors - o(before).noDirectors, o(after).unavailable - o(before).unavailable], [3, 1, 1]);
  assert.equal(o(after).withDirectors + o(after).noDirectors + o(after).unavailable, after.processed, "every checked company is exactly one of the three");
  assert.equal(after.confirmedEligible - before.confirmedEligible, 2, "checked is not confirmed: the empty officer list and the unavailable one are checked but have no confirmed directors");
  // The card's confirmed count covers ALL UK companies: the two eligible ones plus the dissolved company fetched on demand.
  assert.equal(after.confirmedAll - before.confirmedAll, 3);
  assert.equal(after.confirmedDissolved - before.confirmedDissolved, 1, "the dissolved company with a director: this is what made the card's count higher than the modal's");
  assert.equal(after.confirmedEligible + after.confirmedDissolved, after.confirmedAll);
  assert.equal(after.totalUk - before.totalUk, 12, "every UK company created above except the seed row and the overseas-typed one");
  // The user-facing identities, on the real numbers.
  assert.equal(after.remaining, after.eligibleTotal - after.processed);
  assert.equal(after.progressPercent, (after.processed / after.eligibleTotal) * 100);
});

test("ONE snapshot: every figure equals independent counts taken in a single repeatable-read transaction, using the worker's rule and the card's own definition", async () => {
  // ELIGIBLE = the officer worker's rule: every real company of every status (not seed; no other condition). The UK coverage figures = the
  // card's REAL_COMPANIES_WHERE. CONFIRMED = fetched with at least one director / LLP-member record on file (current or historical).
  const { DIRECTOR_ROLES, LLP_MEMBER_ROLES } = await import("../../src/lib/companies-house/officers");
  const eligible = { source: { not: "seed" } };
  const checkedNow = { officersCoverage: { in: ["full", "unavailable"] } };
  const confirmedNow = { officersCoverage: "full", OR: [{ directorCount: { gt: 0 } }, { directors: { some: { role: { in: [...DIRECTOR_ROLES, ...LLP_MEMBER_ROLES] } } } }] };
  const start = todayStart();
  const [total, checked, today, last, totalUk, confirmedAll, confirmedEligible, confirmedDissolved] = await db.$transaction(
    [
      db.company.count({ where: eligible }),
      db.company.count({ where: { ...eligible, ...checkedNow } }),
      db.company.count({ where: { ...eligible, ...checkedNow, officersFetchedAt: { gte: start } } }),
      db.company.aggregate({ where: { ...eligible, ...checkedNow }, _max: { officersFetchedAt: true } }),
      db.company.count({ where: REAL_COMPANIES_WHERE }),
      db.company.count({ where: { ...REAL_COMPANIES_WHERE, ...confirmedNow } }),
      db.company.count({ where: { ...REAL_COMPANIES_WHERE, ...confirmedNow, status: { not: "dissolved" } } }),
      db.company.count({ where: { ...REAL_COMPANIES_WHERE, ...confirmedNow, status: "dissolved" } }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
  const p = await snap();
  assert.equal(p.eligibleTotal, total, "eligible = the officer worker's own rule, counted from the rows");
  assert.equal(p.processed, checked);
  assert.equal(p.processedToday, today);
  assert.equal(p.lastProcessedAt, last._max.officersFetchedAt ? last._max.officersFetchedAt.toISOString() : null, "last successful update = the newest check");
  assert.equal(p.remaining, total - checked);
  assert.equal(p.processed + p.remaining, p.eligibleTotal);
  // The Director Data card's confirmed count and its denominator, from the same snapshot, split exactly into the two parts.
  assert.equal(p.totalUk, totalUk);
  assert.equal(p.confirmedAll, confirmedAll, "the card's count");
  assert.equal(p.confirmedEligible, confirmedEligible);
  assert.equal(p.confirmedDissolved, confirmedDissolved);
  assert.equal(confirmedEligible + confirmedDissolved, confirmedAll);
  assert.equal(p.coveragePercent, (confirmedAll / totalUk) * 100);
  assert.ok(Math.abs(Date.parse(p.asOf) - Date.now()) < 60_000, "the snapshot says when it was taken");
});

test("'remaining' is exactly what the officer worker's own crawl would still visit (its two-phase status rule, copied from officerQueue.crawlPage)", async () => {
  // LIVE lane (active first, then every other live status) + DISSOLVED lane: the two lanes together cover every status.
  const lane = async (cond: string) =>
    Number(
      (
        await db.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM "Company" c WHERE c."officersCoverage" = 'none' AND c."source" <> 'seed' AND ${cond}`
        )
      )[0].n
    );
  const liveLane = await lane(`(c."status" = 'active' OR (c."status" <> 'active' AND c."status" <> 'dissolved'))`);
  const dissolvedLane = await lane(`c."status" = 'dissolved'`);
  const p = await snap();
  assert.equal(p.remaining, liveLane + dissolvedLane, "eligible minus checked = the companies the crawl (live lane + dissolved lane) has not checked yet");
  assert.equal(p.groups!.dissolved.remaining, dissolvedLane);
  assert.equal(p.groups!.active.remaining + p.groups!.other.remaining, liveLane);
});

test("without enough processing history the estimate is 'calculating', never a date", async () => {
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  const p = await snap();
  assert.equal(p.eta.state, "calculating");
  assert.equal(p.eta.date, null);
  await run(2, { crawled: 30_000, processed: 30_000, requests: 30_000, dailyRequestCap: 100_000 });
  await run(1, { crawled: 30_000, processed: 30_000, requests: 30_000, dailyRequestCap: 100_000 });
  assert.equal((await snap()).eta.state, "calculating", "two complete days are not enough");
});

test("the estimate comes from the worker's recorded history, the remaining backlog, failures and the cap it actually enforced", async () => {
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  for (const back of [3, 2, 1]) await run(back, { crawled: 30_000, processed: 30_000, requests: 30_000, dailyRequestCap: 100_000 });

  const steady = await snap();
  assert.equal(steady.eta.state, "estimate");
  assert.equal(steady.pace.perDay, 30_000);
  assert.equal(steady.eta.days, Math.ceil((steady.remaining - steady.parked) / 30_000), "the automatic backlog: remaining without the parked companies");
  assert.equal(steady.eta.date, addDays(utcDay(new Date()), steady.eta.days!));

  // Failures lower the pace.
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  for (const back of [3, 2, 1]) await run(back, { crawled: 30_000, processed: 30_000, failures: 5_000, requests: 30_000, dailyRequestCap: 100_000 });
  assert.equal((await snap()).pace.perDay, 25_000);

  // The cap the worker enforced most recently bounds the pace (10 requests a day here, one request per company).
  await run(1, { crawled: 30_000, processed: 30_000, requests: 30_000, dailyRequestCap: 10 }, 20);
  const capped = await snap();
  assert.equal(capped.pace.perDay, 10);
  assert.equal(capped.pace.capLimited, true);
  assert.equal(capped.eta.days, Math.ceil((capped.remaining - capped.parked) / 10));

  // The worker stopped for the whole last week: no estimate is invented.
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  for (const back of [14, 13, 12, 11, 10]) await run(back, { crawled: 30_000, processed: 30_000, requests: 30_000, dailyRequestCap: 100_000 });
  assert.equal((await snap()).eta.state, "no_recent_processing");
});

test("current processing status follows the worker's own run record", async () => {
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  await db.ingestionRun.create({ data: { kind: "officer_backfill", status: "running", heartbeatAt: new Date(), statsJson: JSON.stringify({ crawled: 5 }) } });
  assert.equal((await snap()).status.state, "processing");

  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  await db.ingestionRun.create({ data: { kind: "officer_backfill", status: "success", heartbeatAt: new Date(), finishedAt: new Date(), statsJson: JSON.stringify({ stopReason: "daily_cap", dailyRequestCap: 3 }) } });
  assert.equal((await snap()).status.state, "paused_daily_cap");

  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  const old = new Date(Date.now() - 3 * 86_400_000);
  await db.ingestionRun.create({ data: { kind: "officer_backfill", status: "failed", startedAt: old, heartbeatAt: old, finishedAt: old, statsJson: "{}" } });
  const quiet = await snap();
  assert.ok(["idle", "between_runs"].includes(quiet.status.state), "an old finished run is not 'processing'");
  assert.notEqual(quiet.status.state, "processing");
});

test("after the REAL officer worker runs, the figures follow it: checked and today's progress go up, a failed company stays in the backlog", async () => {
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  const { enqueueOfficerJobs, OFFICER_PRIORITY } = await import("../../src/lib/companies-house/officerQueue");
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const { resetSharedQuotaState } = await import("../../src/lib/companies-house/quota");
  await resetSharedQuotaState();
  await db.chBreaker.deleteMany();
  await db.officerSyncJob.deleteMany();

  const ok1 = await company();
  const ok2 = await company();
  const gone = await company(); // Companies House has no officer data for it: checked ("unavailable"), not retried
  const failing = await company(); // Companies House answers an error for it: charged an attempt and retried later
  modes.set(gone.companyNumber, "gone");
  modes.set(failing.companyNumber, "fail");
  const before = await snap();
  await enqueueOfficerJobs([ok1.id, ok2.id, gone.id, failing.id], { priority: OFFICER_PRIORITY.REPORT, reason: "report" });

  const stats = await runOfficerWorker({ dailyRequestCap: 100, exitWhenIdle: true, freshness: false, workerId: "w-progress", heartbeatMs: 200 });
  assert.equal(stats.full, 2);
  assert.equal(stats.unavailable, 1);
  assert.equal(stats.failures, 1);

  const after = await snap();
  assert.equal(after.processed - before.processed, 3, "two with officers, one with none at Companies House");
  assert.equal(after.processedToday - before.processedToday, 3);
  assert.equal(after.remaining - before.remaining, -3, "three left the backlog; the failed one is still in it");
  assert.equal(after.remaining, after.eligibleTotal - after.processed);
  assert.equal(after.retrying - before.retrying, 1, "the failed company is waiting for an automatic retry");
  assert.ok(after.lastProcessedAt && Date.now() - Date.parse(after.lastProcessedAt) < 120_000, "the last successful update moved to the check that just happened");
  const job = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: failing.id } });
  assert.ok(job.status === "retry" && job.attempts >= 1);
  assert.equal((await db.company.findUniqueOrThrow({ where: { id: failing.id } })).officersCoverage, "none");

  // After repeated failures the pipeline parks it: it is still "remaining" (eligible minus checked), reported separately, and no longer waited for.
  await db.officerSyncJob.update({ where: { companyId: failing.id }, data: { status: "parked", attempts: 6, parkedAt: new Date() } });
  const parked = await snap();
  assert.equal(parked.remaining, after.remaining, "parking does not change eligible minus checked");
  assert.equal(parked.parked - after.parked, 1);
  assert.equal(parked.retrying - after.retrying, -1);
});

test("the snapshot is refreshed in the background: a viewer gets the last good figures at once, the next one gets the new ones", async () => {
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  const first = await getDirectorProgress({ ttlMs: 0 });
  await company({ officersCoverage: "full", directorCount: 1, officersFetchedAt: new Date() }); // the worker "checks" one more company
  const cached = await getDirectorProgress({ ttlMs: 60_000 });
  assert.equal(cached.processed, first.processed, "inside the freshness window the same snapshot is served");
  await new Promise((r) => setTimeout(r, 30));
  const stale = await getDirectorProgress({ ttlMs: 10 }); // older than 10 ms: served at once, refresh started in the background
  assert.equal(stale.processed, first.processed, "the stale snapshot is returned without waiting");
  let fresh = stale;
  for (let i = 0; i < 100 && fresh.processed === first.processed; i++) {
    await new Promise((r) => setTimeout(r, 100));
    fresh = await getDirectorProgress({ ttlMs: 60_000 });
  }
  assert.equal(fresh.processed, first.processed + 1, "the background refresh picked up the new check");
});

test("the staff dashboard card shows the three summary figures and the link (and none of the processing statistics); customers see the card exactly as before", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "dirprog");
  const html = async (cookie: string) => (await (await fetch(`${BASE}/dashboard`, { headers: { cookie: `director_session=${cookie}` } })).text()).replace(/<!--[\s\S]*?-->/g, "");
  const staff = await html(sa.cookie);
  assert.match(staff, /With confirmed director data/, "the original label");
  assert.ok(staff.includes("director data coverage"), "the original coverage wording");
  assert.ok(!staff.includes("Appointment records") && !staff.includes("Director records imported"), "the card never shows appointment records");
  assert.match(staff, /data-testid="director-progress-open"/);
  assert.ok(staff.includes("View processing progress") && staff.includes("Processing progress"));
  assert.ok(!staff.includes("ds-card-") && !staff.includes("Director data imported"), "no imported / estimate / update / API lines on the card itself");
  for (const text of ["Estimated completion", "Processed today", "eligible companies checked", "confirmed director coverage", "written today", "data-testid=\"dc-appts\"", "Active</", "data-testid=\"director-summary-panel\""]) {
    if (text === "Active</") continue; // the register's own 'Active' tile is a different card
    assert.ok(!staff.includes(text), `${text}: not in the card`);
  }
  for (const label of ["UK companies on the register", "Active", "Dissolved"]) assert.ok(staff.includes(label), label);

  const bcrypt = (await import("bcryptjs")).default;
  const email = `dirprog.${TAG}@test.example`;
  await db.user.create({ data: { email, name: "Dash Customer", passwordHash: await bcrypt.hash(STRONG_PASSWORD, 4), role: "CUSTOMER", permissions: "[]" } });
  const l = await login(email);
  assert.equal(l.status, 200);
  const customer = await html(l.cookie!);
  assert.ok(customer.includes("With confirmed director data"));
  assert.ok(customer.includes("director data coverage") && !customer.includes("confirmed director coverage"), "the customer card keeps its original wording");
  assert.ok(!customer.includes("director-progress-open") && !customer.includes("View processing progress"), "customers never get the link");
  assert.ok(!customer.includes("Estimate, not an exact count") && !customer.includes("Director data imported"), "customers never see the estimate or the imported records");
  await db.user.deleteMany({ where: { email } });
});

test("daily API usage is today's recorded request count (what the worker's cap enforces), never the number of companies processed", async () => {
  const { officerRequestsSpentToday } = await import("../../src/lib/companies-house/officerWorker");
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  // 3 companies processed but 7 requests spent (a company needs several requests: profile, officers pages, retries).
  await db.ingestionRun.create({ data: { kind: "officer_backfill", status: "success", startedAt: new Date(), finishedAt: new Date(), statsJson: JSON.stringify({ crawled: 3, processed: 3, requests: 7, dailyRequestCap: 100_000 }) } });
  const p = await getDirectorProgress({ ttlMs: 0 });
  assert.equal(p.api.usedToday, await officerRequestsSpentToday(), "the same figure the worker's cap check uses");
  assert.equal(p.api.usedToday, 7);
  assert.notEqual(p.api.usedToday, 3, "requests are not processed companies");
  assert.equal(p.api.cap, 100_000);
  assert.equal(p.api.remaining, 100_000 - 7);
  // A run recorded with no cap: the panel reports an unknown cap instead of inventing one.
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  await db.ingestionRun.create({ data: { kind: "officer_backfill", status: "success", startedAt: new Date(), finishedAt: new Date(), statsJson: JSON.stringify({ crawled: 1, processed: 1, requests: 2 }) } });
  const q = await getDirectorProgress({ ttlMs: 0 });
  assert.equal(q.api.usedToday, 2);
  assert.ok(q.api.state === "unknown" || q.api.state === "ok");
});

test("director APPOINTMENTS imported today are counted from the Director rows themselves: current director/LLP roles, today (UTC), eligible companies only", async () => {
  const beforeSnap = await snap();
  const before = beforeSnap.appointments.importedToday;
  const beforeHist = beforeSnap.appointments.importedTodayHistorical;
  assert.equal(typeof before, "number");
  const start = todayStart();
  const yesterday = new Date(start.getTime() - 3_600_000); // 23:00 UTC yesterday
  const live = await company({ status: "active", officersCoverage: "full", directorCount: 3, officersFetchedAt: new Date() });
  const gone = await company({ status: "dissolved", officersCoverage: "full", directorCount: 1, officersFetchedAt: new Date() });
  const row = (companyId: string, role: string, extra: Record<string, unknown> = {}) =>
    db.director.create({ data: { companyId, name: `Test ${role}`, role, officerId: `T${TAG}${Math.random().toString(36).slice(2, 8)}`, source: "rest", ...extra } });
  await row(live.id, "director"); // counts
  await row(live.id, "llp-designated-member"); // counts (LLP member role)
  await row(live.id, "corporate-director"); // counts
  await row(live.id, "secretary"); // a secretary is not a director
  await row(live.id, "director", { resignedOn: new Date("2020-01-01") }); // resigned: not current
  await row(live.id, "director", { createdAt: yesterday }); // written yesterday (23:00 UTC), not today
  await row(gone.id, "director"); // dissolved company: outside the panel's population
  const afterSnap = await snap();
  const after = afterSnap.appointments.importedToday as number;
  assert.equal(after - (before as number), 3, "three current director / LLP-member rows written today in a live company");
  assert.equal((afterSnap.appointments.importedTodayHistorical as number) - (beforeHist as number), 2, "historical: the resigned row, and the appointment of the dissolved company (the yesterday row and the secretary are not counted)");
  // and it is a count of rows, not companies x anything: one company produced three appointments
  const p = await snap();
  assert.ok(p.appointments.importedToday !== p.processedToday);
});

test("the estimated remaining appointments use the real sample: checked companies, unchecked companies and their mean, with a range that brackets the estimate", async () => {
  const { computeAppointmentEstimate, __resetAppointmentEstimate } = await import("../../src/lib/data/director-progress");
  __resetAppointmentEstimate(); // forget the hour-long cache of company counts per stratum, so the counts below are compared like for like
  const e = await computeAppointmentEstimate();
  assert.ok(e, "enough checked companies in the scratch database to sample");
  const { DIRECTOR_ROLES, LLP_MEMBER_ROLES } = await import("../../src/lib/companies-house/officers");
  const eligible = { source: { not: "seed" } }; // every status
  const checked = await db.company.count({ where: { ...eligible, officersCoverage: { in: ["full", "unavailable"] } } });
  assert.equal(e.checkedCompanies, checked, "the sample = every company whose officer data has been fetched or confirmed unavailable, of every status");
  assert.equal(e.uncheckedCompanies, await db.company.count({ where: { ...eligible, officersCoverage: "none" } }));
  const records = await db.director.count({ where: { role: { in: [...DIRECTOR_ROLES, ...LLP_MEMBER_ROLES] }, company: { ...eligible, officersCoverage: { in: ["full", "unavailable"] } } } });
  assert.ok(Math.abs(e.meanPerCompany - records / checked) < 1e-9, "mean = director / LLP-member records (all dates) per checked company, straight from the Director rows");
  assert.ok(e.low <= e.total && e.total <= e.high && e.low >= 0);
  assert.equal(e.current.total + e.historical.total, e.total, "current + historical = the total");
  assert.ok(e.coveredCompanies + e.uncoveredCompanies === e.uncheckedCompanies, "every unchecked company is either covered by a stratum or reported as not covered");
  // it is shipped inside the snapshot, once the estimate has been calculated
  const p = await getDirectorProgress({ ttlMs: 0, waitForEstimate: true });
  assert.ok(p.appointments.estimate && p.appointments.estimate.checkedCompanies > 0);
});

test("the appointment estimate can never stay on 'calculating': it becomes ready, or unavailable when it fails or has nothing to sample, and recovers", async () => {
  const { __setAppointmentEstimateComputer, __resetAppointmentEstimate } = await import("../../src/lib/data/director-progress");
  const sample = {
    total: 1_000, low: 900, high: 1_100, current: { total: 700, low: 650, high: 750 }, historical: { total: 300, low: 250, high: 350 },
    imported: 100, uncheckedDissolved: 0, checkedCompanies: 50, uncheckedCompanies: 500, coveredCompanies: 500, uncoveredCompanies: 0, meanPerCompany: 2, dissolvedChecked: 0, provisional: false,
    asOf: new Date().toISOString(),
  };
  try {
    // a calculation that throws -> unavailable (and the error is not swallowed into "calculating")
    __resetAppointmentEstimate();
    __setAppointmentEstimateComputer(async () => {
      throw new Error("stub failure");
    });
    const failed = await getDirectorProgress({ ttlMs: 0, waitForEstimate: true });
    assert.equal(failed.appointments.estimateStatus, "unavailable");
    assert.equal(failed.appointments.estimate, null);
    // nothing to sample (the calculation returns no estimate) -> unavailable
    __resetAppointmentEstimate();
    __setAppointmentEstimateComputer(async () => null);
    assert.equal((await getDirectorProgress({ ttlMs: 0, waitForEstimate: true })).appointments.estimateStatus, "unavailable");
    // a slow first calculation: viewers see 'calculating' while it runs, and the finished value reaches the very next call, with no snapshot rebuild
    __resetAppointmentEstimate();
    let finish!: () => void;
    __setAppointmentEstimateComputer(() => new Promise((r) => (finish = () => r(sample))));
    const during = await getDirectorProgress({ ttlMs: 60_000 });
    assert.equal(during.appointments.estimateStatus, "calculating");
    finish();
    await new Promise((r) => setTimeout(r, 50));
    const done = await getDirectorProgress({ ttlMs: 60_000 }); // same cached snapshot as 'during'
    assert.equal(done.appointments.estimateStatus, "ready");
    assert.equal(done.appointments.estimate?.total, 1_000);
    assert.equal(done.asOf, during.asOf, "the same snapshot, now carrying the finished estimate");
    // a refresh that fails later keeps the last good estimate, with its own calculation time
    __setAppointmentEstimateComputer(async () => {
      throw new Error("later failure");
    });
    const kept = await getDirectorProgress({ ttlMs: 0, waitForEstimate: true });
    assert.equal(kept.appointments.estimateStatus, "ready");
    assert.equal(kept.appointments.estimate?.asOf, sample.asOf);
  } finally {
    __resetAppointmentEstimate();
  }
});
