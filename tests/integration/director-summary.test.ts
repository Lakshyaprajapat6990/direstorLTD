import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, makeCompany } from "./helpers";
import { getDirectorDataSummary } from "../../src/lib/data/director-summary";
import { __resetAppointmentEstimate, computeAppointmentEstimate } from "../../src/lib/data/director-progress";
import { formatApprox, formatCompact } from "../../src/lib/data/director-progress-calc";

// The three figures of the Director Data card, each checked against the database itself (scratch database only: helpers.ts refuses anything else).
const TAG = String(Date.now() % 1_000_000);
let n = 0;
const created: string[] = [];
const company = async (over: Record<string, unknown> = {}) => {
  const c = await makeCompany({ companyNumber: `DS${TAG}${String(++n).padStart(3, "0")}`, ...over });
  created.push(c.id);
  return c;
};
const dayStart = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

after(async () => {
  await db.chRequestStat.deleteMany({ where: { quotaClass: { startsWith: "zz_test" } } });
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  await db.company.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

test("last successful update = the newest officersFetchedAt of a checked company: the database's timestamp, not the page-load time", async () => {
  const stamp = new Date(Date.now() - 7 * 60_000 - 123); // 7 minutes ago, with milliseconds
  await company({ officersCoverage: "full", directorCount: 1, officersFetchedAt: stamp });
  await company({ officersCoverage: "none" }); // never checked: must not count
  const seed = await company({ officersCoverage: "full", officersFetchedAt: new Date(Date.now() + 3_600_000), source: "seed" }); // a seed row in the "future": ignored
  void seed;
  const truth = await db.company.aggregate({ where: { source: { not: "seed" }, officersCoverage: { in: ["full", "unavailable"] } }, _max: { officersFetchedAt: true } });
  const v = await getDirectorDataSummary({ ttlMs: 0 });
  assert.equal(v.lastUpdate.iso, truth._max.officersFetchedAt!.toISOString());
  assert.ok(Date.parse(v.lastUpdate.iso!) <= Date.now(), "not a future seed row");
  assert.ok(Date.now() - Date.parse(v.lastUpdate.iso!) > 5_000, "it is the stored timestamp, not 'now'");
  assert.match(v.lastUpdate.text, /^[0-9]{2} [A-Z][a-z]{2} [0-9]{4}, [0-9]{2}:[0-9]{2} UTC$/);
});

test("daily API requests come from the SHARED ledger (every request of every job), against the cap the worker recorded; remaining = cap - used", async () => {
  await db.chRequestStat.deleteMany({ where: { bucketStart: { gte: dayStart() } } });
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  const hour = new Date(dayStart().getTime() + 1_000); // inside today's first bucket
  await db.chRequestStat.createMany({
    data: [
      { bucketStart: hour, quotaClass: "backfill", requests: 70 },
      { bucketStart: hour, quotaClass: "user", requests: 5 },
      { bucketStart: new Date(dayStart().getTime() - 3_600_000), quotaClass: "backfill", requests: 999 }, // yesterday: not today's
    ],
  });
  // The officer worker's own tally is LOWER (it counts one request per company): the card must show the ledger.
  await db.ingestionRun.create({ data: { kind: "officer_backfill", status: "success", startedAt: new Date(), finishedAt: new Date(), statsJson: JSON.stringify({ processed: 40, requests: 40, dailyRequestCap: 1_000 }) } });
  const v = await getDirectorDataSummary({ ttlMs: 0 });
  assert.deepEqual([v.api.state, v.api.used, v.api.cap, v.api.remaining], ["ok", "75", "1,000", "925"], "70 + 5 requests from the ledger; not the worker's 40, not yesterday's 999");
  assert.equal(v.api.percentText, "7.50%");
  // no recorded cap: usage is shown, the limit is reported as unknown rather than invented
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });
  const u = await getDirectorDataSummary({ ttlMs: 0 });
  assert.deepEqual([u.api.state, u.api.used, u.api.cap, u.api.remaining], ["unknown", "75", null, null]);
  await db.chRequestStat.deleteMany({ where: { bucketStart: { gte: dayStart() } } });
});

test("estimated director data = every director / LLP-member record already imported (current, resigned AND dissolved companies) + the estimate for the unchecked", async () => {
  const mk = async (status: string, coverage: string) => company({ status, officersCoverage: coverage, directorCount: 1, officersFetchedAt: new Date() });
  const live = await mk("active", "full");
  const gone = await mk("dissolved", "full");
  const row = (companyId: string, role: string, extra: Record<string, unknown> = {}) =>
    db.director.create({ data: { companyId, name: `T ${role}`, role, officerId: `S${TAG}${Math.random().toString(36).slice(2, 9)}`, source: "rest", ...extra } });
  await row(live.id, "director");
  await row(live.id, "director", { resignedOn: new Date("2020-01-01") }); // historical: counted
  await row(live.id, "secretary"); // not a director: never counted
  await row(gone.id, "director"); // a dissolved company's record: counted
  const { DIRECTOR_ROLES, LLP_MEMBER_ROLES } = await import("../../src/lib/companies-house/officers");
  const roles = [...DIRECTOR_ROLES, ...LLP_MEMBER_ROLES];
  const real = { source: { not: "seed" } };
  const all = await db.director.count({ where: { role: { in: roles }, company: real } });
  __resetAppointmentEstimate(); // forget the hour-long cache of company counts per stratum
  const v = await getDirectorDataSummary({ ttlMs: 0, waitForEstimate: true });
  // IMPORTED: the actual count, straight from the Director table (secretaries excluded), split into current and historical
  assert.equal(v.imported.value, all.toLocaleString("en-GB"), "imported = every director / LLP-member row, all statuses, exactly");
  assert.equal(v.imported.total, all);
  assert.ok(all >= 3, "the seeded current, resigned and dissolved-company rows are all in the count (the secretary is not)");
  // ESTIMATED TOTAL: imported + the estimate for the unchecked, labelled as an estimate and kept apart from the count
  const e2 = (await computeAppointmentEstimate())!;
  const supported = e2.uncoveredCompanies === 0 && !e2.provisional;
  // an ALL-status total is shown only when every company has a defensible sample; otherwise NO figure (never a live-only total)
  assert.equal(v.estimate.state, supported ? "ready" : "unavailable");
  assert.equal(v.estimate.value, supported ? "≈ " + formatApprox(all + e2.total) : null);
  assert.equal(v.estimate.remaining, supported ? formatCompact(e2.total) : null);
  assert.equal(v.estimate.status, supported ? null : "Not yet available");
  assert.notEqual(v.estimate.value, v.imported.value);
  assert.equal(e2.imported, all, "the estimate's sample counts exactly the same records");
});

test("estimated time to complete = remaining RECORDS / records actually imported per day (last 7 complete UTC days, inactive days as zero); never companies, never the API limit", async () => {
  const { __setAppointmentEstimateComputer } = await import("../../src/lib/data/director-progress");
  const { formatDuration, addDays, utcDay } = await import("../../src/lib/data/director-progress-calc");
  const { formatDateOnly } = await import("../../src/lib/data/format");
  const roles = ["director", "corporate-director", "nominee-director", "corporate-nominee-director", "llp-member", "llp-designated-member", "corporate-llp-member", "corporate-llp-designated-member"];
  const c = await company({ officersCoverage: "full", directorCount: 1, officersFetchedAt: new Date() });
  const at = (back: number) => new Date(`${utcDay(new Date(Date.now() - back * 86_400_000))}T12:00:00.000Z`);
  const add = async (back: number, n: number, role = "director") => {
    if (n > 0) await db.director.createMany({ data: Array.from({ length: n }, (_, i) => ({ companyId: c.id, name: `ETA ${back} ${i}`, role, officerId: `E${TAG}${back}${i}${role}`, source: "rest", createdAt: at(back) })) });
  };
  // days -1..-7: 40, 0 (a stopped day), 25, 30, 0, 50, 15 records; day -9 (outside the window) 500; a secretary on day -1 (never counted); rows today (a partial day: never used)
  const plan: [number, number][] = [[1, 40], [2, 0], [3, 25], [4, 30], [5, 0], [6, 50], [7, 15], [9, 500], [0, 77]];
  for (const [back, n] of plan) await add(back, n);
  await add(1, 99, "secretary");
  // late evening (23:30 UTC) of yesterday: it belongs to YESTERDAY, whatever the database server time zone is
  await db.director.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ companyId: c.id, name: `ETA late ${i}`, role: "director", officerId: `L${TAG}${i}`, source: "rest", createdAt: new Date(`${utcDay(new Date(Date.now() - 86_400_000))}T23:30:00.000Z`) })) });
  const REMAINING = 12_345_678;
  const sample = {
    total: REMAINING, low: REMAINING - 1_000, high: REMAINING + 1_000, current: { total: 1, low: 1, high: 1 }, historical: { total: 1, low: 1, high: 1 },
    imported: 0, uncheckedDissolved: 0, checkedCompanies: 50, uncheckedCompanies: 500, coveredCompanies: 500, uncoveredCompanies: 0, meanPerCompany: 2, dissolvedChecked: 0, provisional: false, asOf: new Date().toISOString(),
  };
  try {
    __setAppointmentEstimateComputer(async () => sample);
    __resetAppointmentEstimate();
    __setAppointmentEstimateComputer(async () => sample);
    const v = await getDirectorDataSummary({ ttlMs: 0, waitForEstimate: true });
    // the independent figure: qualifying rows created in the 7 complete UTC days before today, per day, from the table itself
    const today = utcDay(new Date());
    const rows = await db.director.findMany({ where: { role: { in: roles }, createdAt: { gte: new Date(`${addDays(today, -7)}T00:00:00.000Z`), lt: new Date(`${today}T00:00:00.000Z`) }, company: { source: { not: "seed" } } }, select: { createdAt: true } });
    const perDay = rows.length / 7;
    assert.ok(rows.length >= 172, "the seeded days are in the window (40+25+30+50+15+12 late-evening rows, plus anything else in the scratch database)");
    const days = Math.ceil(REMAINING / perDay);
    assert.equal(v.eta.state, "ready");
    assert.equal(v.eta.value, "about " + formatDuration(days));
    assert.equal(v.eta.date, formatDateOnly(addDays(today, days)));
    assert.equal(v.eta.pace, Math.round(perDay).toLocaleString("en-GB") + " records a day");
    assert.ok(!v.eta.note.includes("100,000"), "the API request limit plays no part");
    // no all-status estimate -> no completion time
    __resetAppointmentEstimate();
    __setAppointmentEstimateComputer(async () => ({ ...sample, provisional: true, uncoveredCompanies: 5 }));
    const none = await getDirectorDataSummary({ ttlMs: 0, waitForEstimate: true });
    assert.deepEqual([none.eta.value, none.eta.status], [null, "Not yet available"]);
  } finally {
    __setAppointmentEstimateComputer(null);
    __resetAppointmentEstimate();
  }
});

test("the cached estimate is dropped and recalculated when the dissolved random sample changes (a stale cache can never hide a finished sample)", async () => {
  const { currentEstimate } = await import("../../src/lib/data/director-progress");
  __resetAppointmentEstimate();
  const first = await currentEstimate(true); // calculated and cached
  assert.equal(first.status, "ready");
  assert.equal((await currentEstimate(false)).status, "ready", "unchanged sample: the cached estimate is served");
  const c = await company({ status: "dissolved", dissolutionDate: new Date("2037-03-01"), officersCoverage: "full", officersFetchedAt: new Date() });
  await db.dissolvedSample.create({ data: { companyId: c.id, stratum: 2037, kind: "full", batch: "cache-test", frameSize: 10, status: "fetched", records: 2, fetchedAt: new Date() } });
  const during = await currentEstimate(false);
  assert.equal(during.status, "calculating", "a changed sample invalidates the cached estimate at once");
  for (let i = 0; i < 100 && (await currentEstimate(false)).status !== "ready"; i++) await new Promise((r) => setTimeout(r, 300));
  const after = await currentEstimate(false);
  assert.equal(after.status, "ready", "...and the recalculated estimate is served by itself");
  assert.equal(after.estimate?.dissolvedSampled, 1, "the new sample member is part of it");
  await db.dissolvedSample.deleteMany({ where: { companyId: c.id } });
});

test("records imported today = the director / LLP-member rows inserted since 00:00 UTC: not companies, not secretaries, not yesterday's rows", async () => {
  const c = await company({ officersCoverage: "full", directorCount: 2, officersFetchedAt: new Date() });
  const row = (role: string, createdAt: Date) => db.director.create({ data: { companyId: c.id, name: `T ${role}`, role, officerId: `T${TAG}${Math.random().toString(36).slice(2, 9)}`, source: "rest", createdAt } });
  const roles = ["director", "corporate-director", "nominee-director", "corporate-nominee-director", "llp-member", "llp-designated-member", "corporate-llp-member", "corporate-llp-designated-member"];
  const before = await db.director.count({ where: { createdAt: { gte: dayStart() }, role: { in: roles }, company: { source: { not: "seed" } } } });
  await row("director", new Date());
  await row("llp-member", new Date());
  await row("secretary", new Date()); // not a director record
  await row("director", new Date(dayStart().getTime() - 3_600_000)); // yesterday (23:00 UTC): not today's
  __resetAppointmentEstimate();
  const v = await getDirectorDataSummary({ ttlMs: 0, waitForEstimate: true });
  assert.equal(v.importedToday.value, (before + 2).toLocaleString("en-GB"));
  const independent = await db.director.count({ where: { createdAt: { gte: dayStart() }, role: { in: roles }, company: { source: { not: "seed" } } } });
  assert.equal(v.importedToday.value, independent.toLocaleString("en-GB"), "equals an independent count of today's rows");
});

test("a figure is never shown from a stale read: a read older than twice the cache time is refreshed BEFORE it is served, and 'Figures as of' is the time of the read", async () => {
  const c = await company({ officersCoverage: "full", directorCount: 1, officersFetchedAt: new Date() });
  const add = (k: number) => db.director.createMany({ data: Array.from({ length: 3 }, (_, i) => ({ companyId: c.id, name: `FR ${k} ${i}`, role: "director", officerId: `F${TAG}${k}${i}`, source: "rest" })) });
  __resetAppointmentEstimate();
  const a = await getDirectorDataSummary({ ttlMs: 100, waitForEstimate: true });
  const n = Number((a.imported.value ?? "0").replace(/,/g, ""));
  await add(1);
  const b = await getDirectorDataSummary({ ttlMs: 100, waitForEstimate: true }); // within the cache time: served as read
  assert.equal(b.imported.value, a.imported.value);
  await new Promise((r) => setTimeout(r, 350)); // older than twice the cache time
  const d = await getDirectorDataSummary({ ttlMs: 100, waitForEstimate: true });
  assert.equal(Number((d.imported.value ?? "0").replace(/,/g, "")), n + 3, "the new rows are in the figure that is shown");
  assert.notEqual(d.asOfText, undefined);
});
