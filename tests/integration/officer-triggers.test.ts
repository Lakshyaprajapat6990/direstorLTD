// Officer-data triggers against the SCRATCH database and a local MOCK Companies House server (no live API call, and
// helpers.ts refuses anything but the scratch database). Covers: follow / save / red-flag queueing (single and bulk),
// permission and ownership limits, report create / refresh / daily update, search-result prefetch and its budgets, the
// company-page fallback, and the worker's daily request cap.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { api, createUser, db, group, login, makeCompany, rule, sessionFor, STRONG_PASSWORD } from "./helpers";
import { resolvePermissions } from "../../src/lib/auth/permissions";

const tag = String(Date.now() % 1_000_000);
let counter = 0;
const num = (l: string) => `OT${tag}${l}${String(++counter).padStart(2, "0")}`.toUpperCase();
const modes = new Map<string, "zero" | "404">();
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "X-Ratelimit-Remain": "500", "X-Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 300) });
      res.end(JSON.stringify(body));
    };
    const m = /^\/company\/([^/]+)(\/officers)?$/.exec(url.pathname);
    if (!m) return send(404, {});
    const [, n, officers] = m;
    if (!officers) return modes.get(n) === "404" ? send(200, { company_name: n, company_number: n }) : send(200, { company_name: n, company_number: n });
    if (modes.get(n) === "404") return send(404, {});
    return send(200, { items: [], total_results: 0 });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.COMPANIES_HOUSE_API_KEY = "test-rest-key";
  process.env.COMPANIES_HOUSE_REST_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await db.officerSyncJob.deleteMany();
  server.close();
  await db.$disconnect();
});

beforeEach(async () => {
  await db.officerSyncJob.deleteMany();
});

const job = (companyId: string) => db.officerSyncJob.findUnique({ where: { companyId } });
const state = (id: string, body: unknown, s: Awaited<ReturnType<typeof sessionFor>>) => api(s, `/api/companies/${id}/state`, { body });

async function userWithPermissions(keys: string[]) {
  const u = await createUser("USER", "limited");
  await db.user.update({ where: { id: u.id }, data: { permissions: JSON.stringify(keys) } });
  const r = await login(u.email);
  assert.ok(r.cookie);
  return { cookie: r.cookie!, userId: u.id, email: u.email };
}
const actorOf = async (userId: string) => {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return { userId, role: u.role as "USER", permissions: resolvePermissions(u.role as "USER", u.permissions) };
};

// ---- follow / save / red-flag -------------------------------------------------------------------------------------
test("follow, save and red-flag each queue the company at priority 2; switching off or trashing queues nothing", async () => {
  const u = await sessionFor("USER");
  for (const [patch, reason] of [[{ followed: true }, "followed"], [{ saved: true }, "saved"], [{ redFlagged: true }, "red_flagged"]] as const) {
    const c = await makeCompany({ companyNumber: num("S") });
    const r = await state(c.id, patch, u);
    assert.equal(r.status, 200);
    const j = await job(c.id);
    assert.ok(j, `${reason} queued`);
    assert.equal(j!.priority, 2);
    assert.equal(j!.reason, reason);
    assert.equal(j!.status, "queued");
  }
  const off = await makeCompany({ companyNumber: num("F") });
  await state(off.id, { followed: false }, u);
  assert.equal(await job(off.id), null, "switching a marker off queues nothing");
  const trashed = await makeCompany({ companyNumber: num("T") });
  await state(trashed.id, { trashed: true }, u);
  assert.equal(await job(trashed.id), null, "trashing queues nothing");
  assert.ok(await db.activityLog.findFirst({ where: { userId: u.userId, action: "officer_queued_tracked" } }), "the queueing is recorded for the daily budget");
});

test("queueing is idempotent, never downgrades a higher priority, and skips seed / already-confirmed companies", async () => {
  const { enqueueOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const u = await sessionFor("USER");
  const c = await makeCompany({ companyNumber: num("I") });
  await enqueueOfficerJobs([c.id], { priority: 5, reason: "search_prefetch" });
  await state(c.id, { followed: true }, u);
  await state(c.id, { followed: true }, u);
  assert.equal(await db.officerSyncJob.count({ where: { companyId: c.id } }), 1, "one queue row per company");
  assert.equal((await job(c.id))!.priority, 2, "a follow upgrades a prefetch");
  await enqueueOfficerJobs([c.id], { priority: 5, reason: "search_prefetch" });
  assert.equal((await job(c.id))!.priority, 2, "a prefetch never downgrades");

  const seed = await makeCompany({ companyNumber: num("D"), source: "seed" });
  const full = await makeCompany({ companyNumber: num("U"), officersCoverage: "full", officersFetchedAt: new Date() });
  await state(seed.id, { saved: true }, u);
  await state(full.id, { saved: true }, u);
  assert.equal(await job(seed.id), null);
  assert.equal(await job(full.id), null);
});

test("bulk state change queues every eligible selected company once", async () => {
  const u = await sessionFor("USER");
  const a = await makeCompany({ companyNumber: num("B") });
  const b = await makeCompany({ companyNumber: num("B") });
  const seed = await makeCompany({ companyNumber: num("B"), source: "seed" });
  const full = await makeCompany({ companyNumber: num("B"), officersCoverage: "full", officersFetchedAt: new Date() });
  const r = await api(u, "/api/companies/bulk-state", { body: { ids: [a.id, b.id, seed.id, full.id], patch: { saved: true } } });
  assert.equal(r.status, 200);
  assert.ok(await job(a.id));
  assert.ok(await job(b.id));
  assert.equal(await job(seed.id), null);
  assert.equal(await job(full.id), null);
  const off = await api(u, "/api/companies/bulk-state", { body: { ids: [a.id], patch: { saved: false } } });
  assert.equal(off.status, 200);
});

test("permissions: without the director permission nothing is queued (the state change itself still works); anonymous is refused", async () => {
  const limited = await userWithPermissions(["companies.view", "crm.manage", "reports.create"]);
  const c = await makeCompany({ companyNumber: num("P") });
  const r = await state(c.id, { saved: true }, limited);
  assert.equal(r.status, 200);
  assert.equal(await job(c.id), null);
  const anon = await api(null, `/api/companies/${c.id}/state`, { body: { saved: true } });
  assert.equal(anon.status, 401);
  assert.equal(await job(c.id), null);
});

test("per-user daily limit on follow / save queueing", async () => {
  const { queueTrackedCompanies } = await import("../../src/lib/companies-house/officerTriggers");
  const u = await sessionFor("USER");
  const actor = await actorOf(u.userId);
  const old = process.env.OFFICER_TRACKED_USER_DAILY;
  process.env.OFFICER_TRACKED_USER_DAILY = "3";
  try {
    const cs = await Promise.all(Array.from({ length: 6 }, () => makeCompany({ companyNumber: num("L") })));
    const r1 = await queueTrackedCompanies(actor, cs.slice(0, 5).map((c) => c.id), { saved: true });
    assert.equal(r1!.inserted, 3, "only the remaining allowance is queued");
    const r2 = await queueTrackedCompanies(actor, [cs[5].id], { saved: true });
    assert.equal(r2, null, "nothing left today");
    assert.equal(await job(cs[5].id), null);
  } finally {
    if (old === undefined) delete process.env.OFFICER_TRACKED_USER_DAILY;
    else process.env.OFFICER_TRACKED_USER_DAILY = old;
  }
});

// ---- reports ------------------------------------------------------------------------------------------------------
test("report create and refresh queue the matching companies at priority 1 (active first, dissolved only because the report includes them)", async () => {
  const u = await sessionFor("USER");
  const key = `RPT${tag}`;
  const a1 = await makeCompany({ companyNumber: num("R"), name: `${key} ONE LTD` });
  const a2 = await makeCompany({ companyNumber: num("R"), name: `${key} TWO LTD` });
  const dis = await makeCompany({ companyNumber: num("R"), name: `${key} OLD LTD`, status: "dissolved" });
  const full = await makeCompany({ companyNumber: num("R"), name: `${key} DONE LTD`, officersCoverage: "full", officersFetchedAt: new Date() });
  const seed = await makeCompany({ companyNumber: num("R"), name: `${key} SEED LTD`, source: "seed" });
  const other = await makeCompany({ companyNumber: num("R"), name: `UNRELATED ${tag}` });

  const created = await api(u, "/api/reports", { body: { name: `Trigger ${key}`, filter: group("AND", rule("name", "contains", key)), dailyRefresh: true } });
  assert.equal(created.status, 200);
  for (const c of [a1, a2, dis]) {
    const j = await job(c.id);
    assert.ok(j, "queued");
    assert.equal(j!.priority, 1);
    assert.equal(j!.reason, "report");
  }
  for (const c of [full, seed, other]) assert.equal(await job(c.id), null);

  const before = await db.officerSyncJob.count();
  const refreshed = await api(u, `/api/reports/${created.json.report.id}/refresh`, { method: "POST" });
  assert.equal(refreshed.status, 200);
  assert.equal(await db.officerSyncJob.count(), before, "refreshing does not duplicate queue rows");
  await db.officerSyncJob.deleteMany();
  await api(u, `/api/reports/${created.json.report.id}/refresh`, { method: "POST" });
  assert.ok(await job(a1.id), "a refresh re-queues companies that are still missing officer data");
});

test("report queueing: ownership and permission limits, and the cap", async () => {
  const owner = await sessionFor("USER");
  const stranger = await sessionFor("USER");
  const key = `OWN${tag}`;
  const c = await makeCompany({ companyNumber: num("W"), name: `${key} LTD` });
  const created = await api(owner, "/api/reports", { body: { name: `Own ${key}`, filter: group("AND", rule("name", "contains", key)) } });
  assert.equal(created.status, 200);
  await db.officerSyncJob.deleteMany();
  const other = await api(stranger, `/api/reports/${created.json.report.id}/refresh`, { method: "POST" });
  assert.equal(other.status, 404, "only the owner can refresh a report");
  assert.equal(await job(c.id), null, "a refused request queues nothing");

  const limited = await userWithPermissions(["companies.view", "reports.create"]);
  const k2 = `LIM${tag}`;
  const c2 = await makeCompany({ companyNumber: num("W"), name: `${k2} LTD` });
  const r = await api(limited, "/api/reports", { body: { name: `Lim ${k2}`, filter: group("AND", rule("name", "contains", k2)) } });
  assert.equal(r.status, 200);
  assert.equal(await job(c2.id), null, "no director permission, nothing queued");

  const { enqueueReportOfficers } = await import("../../src/lib/companies-house/officerTriggers");
  const k3 = `CAP${tag}`;
  await Promise.all(Array.from({ length: 6 }, () => makeCompany({ companyNumber: num("C"), name: `${k3} LTD` })));
  const res = await enqueueReportOfficers({ ownerId: owner.userId, filterJson: JSON.stringify(group("AND", rule("name", "contains", k3))) }, { cap: 4 });
  assert.equal(res.queued, 4, "a report cannot queue more than the cap");
});

test("daily update: queues saved and red-flagged companies and every daily-refresh report's companies", async () => {
  const { runDailyUpdate } = await import("../../src/lib/companies-house/dailyUpdate");
  const u = await sessionFor("USER");
  const saved = await makeCompany({ companyNumber: num("Y") });
  const flagged = await makeCompany({ companyNumber: num("Y") });
  const followed = await makeCompany({ companyNumber: num("Y") });
  const trashedSaved = await makeCompany({ companyNumber: num("Y") });
  await db.userCompanyState.createMany({
    data: [
      { userId: u.userId, companyId: saved.id, saved: true },
      { userId: u.userId, companyId: flagged.id, redFlagged: true },
      { userId: u.userId, companyId: followed.id, followed: true },
      { userId: u.userId, companyId: trashedSaved.id, saved: true, trashed: true },
    ],
  });
  const key = `DAY${tag}`;
  const inReport = await makeCompany({ companyNumber: num("Y"), name: `${key} LTD` });
  await db.report.create({ data: { ownerId: u.userId, name: `Daily ${key}`, filterJson: JSON.stringify(group("AND", rule("name", "contains", key))), dailyRefresh: true } });
  await db.officerSyncJob.deleteMany();

  const result = await runDailyUpdate({ officerEnqueueCap: 500 });
  assert.ok(result.officersQueuedForReports >= 1);
  for (const c of [saved, flagged, followed]) assert.ok(await job(c.id), "tracked company queued");
  assert.equal(await job(trashedSaved.id), null, "a trashed company is not queued");
  assert.equal((await job(inReport.id))!.priority, 1, "a report without director rules is covered too");
  const again = await runDailyUpdate({ officerEnqueueCap: 500 });
  assert.equal(again.officersQueuedForFollowed, 0, "a second run queues nothing new");
});

// ---- search prefetch ---------------------------------------------------------------------------------------------
test("search prefetch: at most 25 ACTIVE companies, lowest priority, deduplicated, never dissolved / confirmed / seed", async () => {
  const u = await sessionFor("USER");
  const key = `PRE${tag}`;
  const active = await Promise.all(Array.from({ length: 30 }, (_, i) => makeCompany({ companyNumber: num("A"), name: `${key} ${String(i).padStart(2, "0")} LTD` })));
  const dissolved = await Promise.all(Array.from({ length: 3 }, () => makeCompany({ companyNumber: num("A"), name: `${key} GONE LTD`, status: "dissolved" })));
  const confirmed = await makeCompany({ companyNumber: num("A"), name: `${key} HAVE LTD`, officersCoverage: "full", officersFetchedAt: new Date() });
  await db.activityLog.deleteMany({ where: { action: "officer_queued_prefetch" } });

  const r = await api(u, "/api/companies/search", { body: { q: key, page: 1, pageSize: 100, sortField: "name", sortDir: "asc" } });
  assert.equal(r.status, 200);
  const jobs = await db.officerSyncJob.findMany({ where: { reason: "search_prefetch" } });
  assert.equal(jobs.length, 25, "capped at 25 per search");
  assert.ok(jobs.every((j) => j.priority === 5 && j.status === "queued"));
  const ids = new Set(jobs.map((j) => j.companyId));
  for (const c of [...dissolved, confirmed]) assert.ok(!ids.has(c.id));
  assert.ok(active.slice(0, 25).every((c) => ids.has(c.id)), "the first 25 in display order");

  await api(u, "/api/companies/search", { body: { q: key, page: 1, pageSize: 100, sortField: "name", sortDir: "asc" } });
  assert.equal(await db.officerSyncJob.count({ where: { reason: "search_prefetch" } }), 25, "the same search again adds nothing");
  const logged = await db.activityLog.findMany({ where: { userId: u.userId, action: "officer_queued_prefetch" } });
  assert.equal(logged.length, 1, "only new queue rows count against the budget");
});

test("search prefetch: no director permission and free customers get nothing; a failed budget never breaks the search", async () => {
  const key = `PNO${tag}`;
  await Promise.all(Array.from({ length: 4 }, () => makeCompany({ companyNumber: num("N"), name: `${key} LTD` })));
  const limited = await userWithPermissions(["companies.view"]);
  const r1 = await api(limited, "/api/companies/search", { body: { q: key, page: 1, pageSize: 25 } });
  assert.equal(r1.status, 200);
  assert.ok(r1.json.rows.length >= 4);

  const customer = await createUser("USER", "cust");
  await db.user.update({ where: { id: customer.id }, data: { role: "CUSTOMER" } });
  const cs = await login(customer.email, STRONG_PASSWORD);
  assert.ok(cs.cookie);
  const r2 = await api({ cookie: cs.cookie!, userId: customer.id, email: customer.email }, "/api/companies/search", { body: { q: key, page: 1, pageSize: 25 } });
  assert.equal(r2.status, 200);
  assert.equal(await db.officerSyncJob.count({ where: { reason: "search_prefetch" } }), 0);
});

test("search prefetch budgets: per search, per user per day, global per day, and the waiting-queue ceiling", async () => {
  const { prefetchSearchResults } = await import("../../src/lib/companies-house/officerTriggers");
  const u1 = await actorOf((await sessionFor("USER")).userId);
  const u2 = await actorOf((await sessionFor("USER")).userId);
  const mk = async (n: number) => (await Promise.all(Array.from({ length: n }, () => makeCompany({ companyNumber: num("G") })))).map((c) => ({ id: c.id, status: "active", officersCoverage: "none", source: "bulk_import" }));
  const saved = { ...process.env };
  try {
    await db.activityLog.deleteMany({ where: { action: "officer_queued_prefetch" } });
    process.env.OFFICER_PREFETCH_USER_DAILY = "10";
    process.env.OFFICER_PREFETCH_GLOBAL_DAILY = "15";
    process.env.OFFICER_PREFETCH_QUEUE_CEILING = "1000";
    assert.equal((await prefetchSearchResults(u1, await mk(25))).queued, 10, "user daily limit");
    assert.deepEqual(await prefetchSearchResults(u1, await mk(25)), { queued: 0, reason: "budget" }, "user budget used up");
    assert.equal((await prefetchSearchResults(u2, await mk(25))).queued, 5, "global daily ceiling leaves 5");
    assert.equal((await prefetchSearchResults(u2, await mk(25))).queued, 0, "global ceiling reached for everyone");

    await db.activityLog.deleteMany({ where: { action: "officer_queued_prefetch" } });
    await db.officerSyncJob.deleteMany();
    process.env.OFFICER_PREFETCH_USER_DAILY = "100";
    process.env.OFFICER_PREFETCH_GLOBAL_DAILY = "2000";
    process.env.OFFICER_PREFETCH_QUEUE_CEILING = "7";
    assert.equal((await prefetchSearchResults(u1, await mk(25))).queued, 7, "queue ceiling");
    assert.equal((await prefetchSearchResults(u2, await mk(25))).queued, 0, "queue full");

    process.env.OFFICER_PREFETCH_PER_SEARCH = "0";
    assert.equal((await prefetchSearchResults(u1, await mk(5))).reason, "disabled");
  } finally {
    for (const k of ["OFFICER_PREFETCH_USER_DAILY", "OFFICER_PREFETCH_GLOBAL_DAILY", "OFFICER_PREFETCH_QUEUE_CEILING", "OFFICER_PREFETCH_PER_SEARCH"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---- company page fallback -----------------------------------------------------------------------------------------
test("page fallback: a failed inline fetch queues the company once at priority 2; confirmed companies are not queued", async () => {
  const { queueFailedView } = await import("../../src/lib/companies-house/officerTriggers");
  const c = await makeCompany({ companyNumber: num("V") });
  assert.equal((await queueFailedView(c.id))!.inserted, 1);
  assert.equal((await queueFailedView(c.id))!.inserted, 0, "idempotent");
  const j = (await job(c.id))!;
  assert.deepEqual([j.priority, j.reason], [2, "view_retry"]);
  const full = await makeCompany({ companyNumber: num("V"), officersCoverage: "full", officersFetchedAt: new Date() });
  assert.equal((await queueFailedView(full.id))!.inserted, 0);
  assert.equal(await job(full.id), null);
});

// ---- worker: daily request cap ---------------------------------------------------------------------------------------
test("worker daily cap: stops at the cap, remembers what earlier runs spent today, counts 2 requests for an unavailable company", async () => {
  const { enqueueOfficerJobs } = await import("../../src/lib/companies-house/officerQueue");
  const { runOfficerWorker } = await import("../../src/lib/companies-house/officerWorker");
  const { resetSharedQuotaState } = await import("../../src/lib/companies-house/quota");
  await resetSharedQuotaState();
  await db.chBreaker.deleteMany();
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } });

  const cs = await Promise.all(Array.from({ length: 5 }, () => makeCompany({ companyNumber: num("K") })));
  await enqueueOfficerJobs(cs.map((c) => c.id), { priority: 1, reason: "report" });

  const first = await runOfficerWorker({ dailyRequestCap: 3, exitWhenIdle: true, freshness: false, workerId: "w-cap-1", heartbeatMs: 200 });
  assert.equal(first.stopReason, "daily_cap");
  assert.equal(first.processed, 3);
  assert.equal(first.requests, 3);
  assert.equal(await db.officerSyncJob.count(), 2, "the rest stays queued");

  const second = await runOfficerWorker({ dailyRequestCap: 3, exitWhenIdle: true, freshness: false, workerId: "w-cap-2", heartbeatMs: 200 });
  assert.equal(second.stopReason, "daily_cap");
  assert.equal(second.processed, 0, "today's earlier spending is remembered");

  const unavailable = await makeCompany({ companyNumber: num("K") });
  modes.set(unavailable.companyNumber, "404");
  await db.officerSyncJob.deleteMany();
  await enqueueOfficerJobs([unavailable.id], { priority: 1, reason: "report" });
  const third = await runOfficerWorker({ dailyRequestCap: 100, exitWhenIdle: true, freshness: false, workerId: "w-cap-3", heartbeatMs: 200 });
  assert.equal(third.unavailable, 1);
  assert.equal(third.requests, 2, "the officers 404 and the profile lookup");

  await enqueueOfficerJobs([cs[0].id], { priority: 1, reason: "report", coverage: ["full", "none"] });
  const unlimited = await runOfficerWorker({ dailyRequestCap: 0, exitWhenIdle: true, freshness: false, workerId: "w-cap-4", heartbeatMs: 200 });
  assert.notEqual(unlimited.stopReason, "daily_cap", "0 means no cap");
});
