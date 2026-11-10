import { test, after } from "node:test";
import assert from "node:assert/strict";
import { api, db, group, makeCompany, rule, sessionFor, type Session } from "./helpers";
import { runDailyUpdate } from "../../src/lib/companies-house/dailyUpdate";
import { DAILY_UPDATE_STALE_AFTER_MS, dailyUpdateFreshness } from "../../src/lib/jobs/display";

// "Daily updates" in this project = the scheduled daily_update job (overdue flags, filing events, officer queueing and the recompute of
// every report flagged dailyRefresh), plus what a user's own actions record (ActivityLog) and show back to that user. These tests
// follow the real flows end to end on the scratch database: save a report, apply filters, reload, run the job, switch user.
after(async () => {
  await db.$disconnect();
});

const uniq = () => Math.random().toString(36).slice(2, 8);
const filterFor = (tag: string) => group("AND", rule("name", "startsWith", `DUE2E ${tag}`));
const acts = (userId: string, action: string, extra: object = {}) => db.activityLog.findMany({ where: { userId, action, ...extra }, orderBy: { createdAt: "asc" } });

// ---- saving a report ---------------------------------------------------------------------------------------------------------------
test("saving a report persists it with its filter and an accurate count, records one event for the right user and report, and survives a reload", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `DUE2E ${tag} A` });
  await makeCompany({ name: `DUE2E ${tag} B` });
  const before = Date.now();
  const saved = await api(s, "/api/reports", { body: { name: `Saved ${tag}`, filter: filterFor(tag), dailyRefresh: true } });
  assert.equal(saved.status, 200, saved.text);
  const id = saved.json.report.id as string;
  const row = await db.report.findUniqueOrThrow({ where: { id } });
  assert.equal(row.ownerId, s.userId);
  assert.equal(row.resultCount, 2, "the count is the live count at save time");
  const stored = JSON.parse(row.filterJson);
  assert.equal(stored.children[0].field, "name");
  assert.equal(stored.children[0].value, `DUE2E ${tag}`, "the saved filter is the one that was applied");
  assert.ok(row.lastRunAt && row.lastRunAt.getTime() >= before - 1000);
  assert.equal(row.lastAutoRefreshAt, null, "saving is not an automatic update");

  const events = await acts(s.userId, "report_created", { reportId: id });
  assert.equal(events.length, 1, "exactly one event for the save");
  assert.equal(events[0].reportId, id);
  assert.equal(JSON.parse(events[0].meta ?? "{}").name, `Saved ${tag}`);

  // reload / navigate away and back: the report and its event are still there, and nothing new is recorded by listing
  for (let i = 0; i < 2; i++) {
    const list = await api(s, "/api/reports");
    assert.ok((list.json.reports as { id: string }[]).some((r) => r.id === id), "listed after reload");
  }
  assert.equal((await acts(s.userId, "report_created", { reportId: id })).length, 1, "reloading does not create updates");
});

test("a failed save (invalid filter, missing name, refused permission) stores nothing and records no success event", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  const reportsBefore = await db.report.count({ where: { ownerId: s.userId } });
  const bad = await api(s, "/api/reports", { body: { name: `Bad ${tag}`, filter: { id: "g", kind: "group", combinator: "AND", children: [{ id: "r", kind: "rule", field: "no_such_field", operator: "equals", value: "x" }] } } });
  assert.equal(bad.status, 400);
  const noName = await api(s, "/api/reports", { body: { name: "", filter: filterFor(tag) } });
  assert.equal(noName.status, 400);
  const anon = await api(null, "/api/reports", { body: { name: `Anon ${tag}`, filter: filterFor(tag) } });
  assert.equal(anon.status, 401);
  assert.equal(await db.report.count({ where: { ownerId: s.userId } }), reportsBefore, "nothing was stored");
  assert.equal((await acts(s.userId, "report_created")).length, 0, "no success event for a failed save");
});

test("editing a report in place records an update for the same report (no duplicate report), and a deleted report records its own event", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `DUE2E ${tag} A` });
  const id = (await api(s, "/api/reports", { body: { name: `Edit ${tag}`, filter: filterFor(tag) } })).json.report.id as string;
  const edited = await api(s, `/api/reports/${id}`, { method: "PATCH", body: { name: `Edited ${tag}`, filter: group("AND", rule("name", "startsWith", `DUE2E ${tag} A`)) } });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(await db.report.count({ where: { ownerId: s.userId } }), 1, "edited in place");
  assert.equal((await acts(s.userId, "report_updated", { reportId: id })).length, 1);
  const failed = await api(s, `/api/reports/${id}`, { method: "PATCH", body: { filter: { id: "g", kind: "group", combinator: "AND", children: [{ id: "r", kind: "rule", field: "nope", operator: "equals", value: "x" }] } } });
  assert.equal(failed.status, 400);
  assert.equal((await acts(s.userId, "report_updated", { reportId: id })).length, 1, "a refused edit adds no event");
  assert.equal((await api(s, `/api/reports/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await acts(s.userId, "report_deleted", { reportId: id })).length, 1);
});

// ---- applying filters ------------------------------------------------------------------------------------------------------------------
test("applying a filter records one search event (repeats collapse), an empty search records none, a no-result search records a total of 0, and the event belongs to the user who searched", async () => {
  const a = await sessionFor("USER");
  const b = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `DUE2E ${tag} A` });
  const search = (s: Session, filter: unknown, q?: string) => api(s, "/api/companies/search", { body: { filter, q, page: 1, pageSize: 25 } });

  assert.equal((await search(a, group("AND"))).status, 200);
  assert.equal((await acts(a.userId, "search")).length, 0, "no filter and no text: not recorded");

  assert.equal((await search(a, filterFor(tag))).status, 200);
  assert.equal((await search(a, filterFor(tag))).status, 200); // a re-sort / tab switch / live count repeat
  const events = await acts(a.userId, "search");
  assert.equal(events.length, 1, "identical repeats collapse");
  assert.equal(JSON.parse(events[0].meta!).total, 1);
  assert.equal(JSON.parse(events[0].meta!).activeRules, 1);

  const none = await search(a, group("AND", rule("name", "startsWith", `DUE2E ${tag} NOPE`)));
  assert.equal(none.status, 200);
  assert.equal(none.json.total, 0);
  const last = (await acts(a.userId, "search")).at(-1)!;
  assert.equal(JSON.parse(last.meta!).total, 0, "a search that finds nothing is recorded as 0, not hidden");

  assert.equal((await acts(b.userId, "search")).length, 0, "another user's feed is untouched");
  const bad = await search(a, { id: "g", kind: "group", combinator: "AND", children: [{ id: "r", kind: "rule", field: "nope", operator: "equals", value: "x" }] });
  assert.equal(bad.status, 400);
  assert.equal((await acts(a.userId, "search")).length, 2, "a refused filter records nothing");
});

test("the dashboard shows each user only their own updates", async () => {
  const a = await sessionFor("USER");
  const b = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `DUE2E ${tag} A` });
  await api(a, "/api/reports", { body: { name: `Private ${tag}`, filter: filterFor(tag) } });
  const page = async (s: Session) => (await (await fetch(`${process.env.TEST_BASE_URL ?? "http://127.0.0.1:3211"}/dashboard`, { headers: { cookie: `director_session=${s.cookie}` } })).text()).replace(/<!--[\s\S]*?-->/g, "");
  assert.ok((await page(a)).includes(`Private ${tag}`), "the owner sees the report");
  assert.ok(!(await page(b)).includes(`Private ${tag}`), "another user does not");
});

// ---- the scheduled daily update --------------------------------------------------------------------------------------------------------
test("until the daily job runs a saved report stays as saved; after it runs the stored count follows the register for each owner and equals what the report page itself lists", async () => {
  const a = await sessionFor("USER");
  const b = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `DUE2E ${tag} A` });
  await makeCompany({ name: `DUE2E ${tag} B` });
  const ra = (await api(a, "/api/reports", { body: { name: `A ${tag}`, filter: filterFor(tag), dailyRefresh: true } })).json.report.id as string;
  const rb = (await api(b, "/api/reports", { body: { name: `B ${tag}`, filter: filterFor(tag), dailyRefresh: true } })).json.report.id as string;
  assert.equal((await db.report.findUniqueOrThrow({ where: { id: ra } })).resultCount, 2);

  await makeCompany({ name: `DUE2E ${tag} C` }); // registered after the reports were saved
  assert.equal((await db.report.findUniqueOrThrow({ where: { id: ra } })).resultCount, 2, "no job yet: still as saved (page loads never change it)");
  assert.equal((await db.report.findUniqueOrThrow({ where: { id: ra } })).lastAutoRefreshAt, null);
  assert.equal((await api(a, `/api/reports/${ra}`)).json.total, 3, "the report page lists the live register");

  const result = await runDailyUpdate({ officerEnqueueCap: 0 });
  assert.equal(result.reportsFailed, 0);
  const A = await db.report.findUniqueOrThrow({ where: { id: ra } });
  const B = await db.report.findUniqueOrThrow({ where: { id: rb } });
  assert.equal(A.resultCount, 3);
  assert.equal(B.resultCount, 3);
  assert.ok(A.lastAutoRefreshAt && B.lastAutoRefreshAt);
  // The stored count, the report page's own total and the next job all use one query, so they cannot disagree.
  assert.equal((await api(a, `/api/reports/${ra}`)).json.total, A.resultCount);
  assert.equal((await api(b, `/api/reports/${rb}`)).json.total, B.resultCount);
  // Ownership: a user cannot open another user's report.
  assert.equal((await api(b, `/api/reports/${ra}`)).status, 404);
});

test("the daily job marks a run, leaves other users' reports alone when one report is broken, and records the broken one's error", async () => {
  const s = await sessionFor("USER");
  const tag = uniq();
  await makeCompany({ name: `DUE2E ${tag} A` });
  const good = (await api(s, "/api/reports", { body: { name: `Good ${tag}`, filter: filterFor(tag) } })).json.report.id as string;
  const broken = await db.report.create({ data: { ownerId: s.userId, name: `Broken ${tag}`, filterJson: "{not json", dailyRefresh: true, resultCount: 7 } });
  const before = Date.now();
  const result = await runDailyUpdate({ officerEnqueueCap: 0 });
  assert.ok(result.reportsFailed >= 1);
  const g = await db.report.findUniqueOrThrow({ where: { id: good } });
  assert.ok(g.lastAutoRefreshAt && g.lastAutoRefreshAt.getTime() >= before - 100, "the healthy report was still refreshed");
  const br = await db.report.findUniqueOrThrow({ where: { id: broken.id } });
  assert.equal(br.lastAutoRefreshAt, null, "a failure never claims an update");
  assert.ok(br.lastRefreshError, "the error is recorded");
  assert.equal(br.resultCount, 7, "the old count is not overwritten");
  const run = await db.ingestionRun.findFirst({ where: { kind: "daily_update" }, orderBy: { startedAt: "desc" } });
  assert.ok(run && run.status !== "running", "the run is closed");
});

test("overdue flags follow the UTC calendar day: due yesterday is late, due today is not, and the flag clears when the date moves on", async () => {
  const day = 86_400_000;
  const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  const late = await makeCompany({ name: `DUE2E LATE ${uniq()}`, accountsNextDue: new Date(today.getTime() - day) });
  const dueToday = await makeCompany({ name: `DUE2E TODAY ${uniq()}`, accountsNextDue: today });
  const moved = await makeCompany({ name: `DUE2E MOVED ${uniq()}`, accountsNextDue: new Date(today.getTime() + 30 * day), accountsOverdue: true });
  await runDailyUpdate({ officerEnqueueCap: 0 });
  const get = (id: string) => db.company.findUniqueOrThrow({ where: { id } });
  assert.equal((await get(late.id)).accountsOverdue, true);
  assert.equal((await get(dueToday.id)).accountsOverdue, false, "the due day itself is not late yet");
  assert.equal((await get(moved.id)).accountsOverdue, false, "a stale flag clears");
});

// ---- the status the dashboard shows ------------------------------------------------------------------------------------------------------
test("the dashboard's daily-update status is amber when the job has never run or has missed a day, never green on an old run", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  assert.deepEqual(dailyUpdateFreshness(null, now), { tone: "amber", overdue: false });
  assert.deepEqual(dailyUpdateFreshness(undefined, now), { tone: "amber", overdue: false });
  assert.deepEqual(dailyUpdateFreshness(new Date("2026-10-28T03:00:30Z"), now), { tone: "green", overdue: false });
  assert.deepEqual(dailyUpdateFreshness(new Date(now.getTime() - DAILY_UPDATE_STALE_AFTER_MS), now), { tone: "green", overdue: false }, "exactly at the limit is still current");
  assert.deepEqual(dailyUpdateFreshness(new Date(now.getTime() - DAILY_UPDATE_STALE_AFTER_MS - 1), now), { tone: "amber", overdue: true });
  assert.deepEqual(dailyUpdateFreshness(new Date("2026-10-07T05:16:57Z"), now), { tone: "amber", overdue: true }, "three weeks old");
  assert.deepEqual(dailyUpdateFreshness(new Date("not a date"), now), { tone: "amber", overdue: false }, "a malformed time is not treated as current");
});
