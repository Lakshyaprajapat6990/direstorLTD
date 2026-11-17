import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { api, db, makeCompany, sessionFor } from "./helpers";

// Automatic-synchronisation suite: scheduler lease / heartbeat / duplicate-instance protection, restart recovery, new-registration
// checkpoint + duplicate + >5,000-day handling, the scheduled dissolved / status refresh, freshness and health. Scratch database only
// (helpers imports the scratch-DB guard first). Companies House is a LOCAL STUB: no live API request is ever made.

type Fixture = {
  company_number: string;
  company_name: string;
  company_status: string;
  company_type: string;
  date_of_creation: string;
  date_of_cessation?: string;
  sic_codes?: string[];
};
const stub = {
  fixtures: [] as Fixture[],
  // For a one-day incorporation query without a status filter: generate this many companies for that day.
  perDay: 0,
  // Per-request page size: items beyond it are cut off while `hits` stays true (the real API behaviour for a too-large day).
  page: 5000,
  failDays: new Set<string>(),
  empty: new Set<string>(),
  failAll: false,
  requests: [] as Record<string, string>[],
  officerRequests: [] as string[], // company numbers whose profile / officers the scheduler's officer worker asked for
};
let server: http.Server;
let baseUrl = "";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dl-sched-"));
const PREFIX = ["ZT", "ST"];

const item = (num: string, status = "active", type = "ltd", created = "2026-01-05", cessation?: string): Fixture => ({
  company_number: num,
  company_name: `STUB ${num} LTD`,
  company_status: status,
  company_type: type,
  date_of_creation: created,
  ...(cessation ? { date_of_cessation: cessation } : {}),
  sic_codes: ["62020"],
});

function matches(q: Record<string, string>): Fixture[] {
  let rows = stub.fixtures.filter(
    (f) =>
      (!q.company_status || f.company_status === q.company_status) &&
      (!q.company_type || f.company_type === q.company_type) &&
      (!q.incorporated_from || f.date_of_creation >= q.incorporated_from) &&
      (!q.incorporated_to || f.date_of_creation <= q.incorporated_to) &&
      (!q.dissolved_from || (f.date_of_cessation ?? "") >= q.dissolved_from) &&
      (!q.dissolved_to || (f.date_of_cessation !== undefined && f.date_of_cessation <= q.dissolved_to))
  );
  if (stub.perDay > 0 && q.incorporated_from && q.incorporated_from === q.incorporated_to && !q.company_status && !q.company_type) {
    const d = q.incorporated_from.replaceAll("-", "");
    rows = [...rows, ...Array.from({ length: stub.perDay }, (_, i) => item(`ST${d}${i}`, "active", "ltd", q.incorporated_from))];
  }
  return rows;
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const q = Object.fromEntries(url.searchParams.entries());
    stub.requests.push(q);
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "x-ratelimit-remain": "500", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 300) });
      res.end(JSON.stringify(body));
    };
    const co = /^\/company\/([^/]+)(\/officers)?$/.exec(url.pathname); // the officer worker: profile + (empty) officer list
    if (co) {
      stub.officerRequests.push(co[1]);
      return send(200, co[2] ? { items: [], total_results: 0 } : { company_name: co[1], company_number: co[1] });
    }
    if (!url.pathname.startsWith("/advanced-search/companies")) return send(404, {});
    const day = q.incorporated_from && q.incorporated_from === q.incorporated_to ? q.incorporated_from : null;
    if (stub.failAll || (day && stub.failDays.has(day))) return send(400, { error: "stub failure" }); // 400: a hard, non-retried failure (a 5xx would also trip the outage breaker and wait out the client backoff)
    if (day && stub.empty.has(day)) return send(404, {});
    const found = matches(q);
    if (found.length === 0) return send(404, {});
    send(200, { items: found.slice(0, Math.min(Number(q.size) || 5000, stub.page)), hits: found.length });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.COMPANIES_HOUSE_API_KEY = "test-rest-key";
  process.env.COMPANIES_HOUSE_REST_BASE_URL = baseUrl;
  process.env.CH_QUOTA_PACING = "0"; // no pacing delays against the local stub
});

async function cleanup() {
  await db.officerSyncJob.deleteMany({ where: { company: { companyNumber: { startsWith: "ZT" } } } });
  await db.officerSyncJob.deleteMany({ where: { company: { companyNumber: { startsWith: "ST" } } } });
  for (const p of PREFIX) await db.company.deleteMany({ where: { companyNumber: { startsWith: p } } });
  await db.ingestionRun.deleteMany({ where: { OR: [{ kind: "scheduler" }, { inputName: { startsWith: "2026-01" } }, { inputName: { contains: "|dissolved>=" } }, { inputName: { contains: "|adaptive" } }] } });
}

after(async () => {
  await cleanup();
  await db.ingestionRun.deleteMany({ where: { kind: { in: ["new_registrations", "daily_update"] }, inputName: null, startedAt: { gt: new Date(Date.now() - 3_600_000) }, rowsRead: 0 } });
  // Leave the shared quota gate and breakers as clean as found: later suites (e.g. stream-ds01) never reset them themselves, and this
  // suite spends many gated requests (stub + child schedulers) inside the same five-minute window.
  const { resetSharedQuotaState } = await import("../../src/lib/companies-house/quota");
  await resetSharedQuotaState();
  await db.chBreaker.deleteMany();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.$disconnect();
});

beforeEach(async () => {
  // A clean quota gate and breaker for every test (the gate lives in the database, shared with the child scheduler processes).
  const { resetSharedQuotaState } = await import("../../src/lib/companies-house/quota");
  await resetSharedQuotaState();
  await db.chBreaker.deleteMany();
});

const lease = () => import("../../src/lib/jobs/schedulerLease");

// ---- C8: lease, heartbeat, duplicate protection -------------------------------------------------------------------------------
test("lease: a second scheduler wanting the same job is refused; a disjoint job set coexists", async () => {
  await cleanup();
  const { acquireSchedulerLease, SchedulerAlreadyRunningError } = await lease();
  const a = await acquireSchedulerLease("host-a:1", ["new_registrations", "daily_update"]);
  await assert.rejects(() => acquireSchedulerLease("host-b:2", ["daily_update", "officer_worker"]), (e: unknown) => e instanceof SchedulerAlreadyRunningError && /daily_update/.test((e as Error).message));
  const c = await acquireSchedulerLease("host-c:3", ["officer_worker"]); // the existing local setup: registrations in one scheduler, officers in another
  assert.equal(c.status, "running");
  assert.equal((await db.ingestionRun.count({ where: { kind: "scheduler", status: "running" } })), 2);
  void a;
});

test("lease: two schedulers starting at the same instant - exactly one wins (advisory lock)", async () => {
  await cleanup();
  const { acquireSchedulerLease } = await lease();
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => acquireSchedulerLease(`race:${i}`, ["new_registrations", "stream"])));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await db.ingestionRun.count({ where: { kind: "scheduler", status: "running" } }), 1);
});

test("lease: a crashed scheduler (no heartbeat for 2 minutes) is reconciled and its replacement takes over; the old one must stand down", async () => {
  await cleanup();
  const { acquireSchedulerLease, heartbeatSchedulerLease } = await lease();
  const old = await acquireSchedulerLease("crashed:1", ["new_registrations"]);
  await assert.rejects(() => acquireSchedulerLease("replacement:2", ["new_registrations"])); // too early: the first is still considered alive
  await db.ingestionRun.update({ where: { id: old.id }, data: { heartbeatAt: new Date(Date.now() - 3 * 60_000) } }); // 3 minutes of silence
  const fresh = await acquireSchedulerLease("replacement:2", ["new_registrations"]);
  assert.equal((await db.ingestionRun.findUniqueOrThrow({ where: { id: old.id } })).status, "failed"); // reconciled
  // The "dead" process was only paused (laptop sleep): its next heartbeat must tell it a newer scheduler owns the job.
  const hb = await heartbeatSchedulerLease(old.id, ["new_registrations"]);
  assert.equal(hb.ok, false);
  assert.equal((await heartbeatSchedulerLease(fresh.id, ["new_registrations"])).ok, true);
});

test("lease: a graceful release frees the jobs at once and keeps the stop reason", async () => {
  await cleanup();
  const { acquireSchedulerLease, releaseSchedulerLease } = await lease();
  const a = await acquireSchedulerLease("graceful:1", ["new_registrations", "officer_worker"]);
  await releaseSchedulerLease(a.id, "received SIGTERM", ["new_registrations", "officer_worker"]);
  const row = await db.ingestionRun.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(row.status, "success");
  assert.match(row.statsJson ?? "", /received SIGTERM/);
  const b = await acquireSchedulerLease("graceful:2", ["new_registrations", "officer_worker"]);
  assert.equal(b.status, "running");
});

test("scheduler status: alive with a fresh heartbeat, down with a stale one, never-seen when there is no row", async () => {
  await cleanup();
  const { loadSchedulerStatus, acquireSchedulerLease } = await lease();
  assert.equal((await loadSchedulerStatus()).neverSeen, true);
  const a = await acquireSchedulerLease("status:1", ["new_registrations", "dissolved_refresh"]);
  let s = await loadSchedulerStatus();
  assert.equal(s.alive, true);
  assert.deepEqual([...s.jobs].sort(), ["dissolved_refresh", "new_registrations"]);
  await db.ingestionRun.update({ where: { id: a.id }, data: { heartbeatAt: new Date(Date.now() - 20 * 60_000) } });
  s = await loadSchedulerStatus();
  assert.equal(s.alive, false);
  assert.deepEqual([...s.jobs].sort(), ["dissolved_refresh", "new_registrations"]); // what SHOULD be running is still known
});

// ---- A: new registrations - checkpoint, overlap, duplicates, retries, queueing --------------------------------------------------
async function runReg(opts: { from: string; to: string }) {
  const { syncNewRegistrations } = await import("../../src/lib/companies-house/newRegistrations");
  return syncNewRegistrations({ ...opts });
}

test("new registrations: stores each day once, re-running the window never duplicates, and new live companies are queued for officer data", async () => {
  await cleanup();
  stub.fixtures = [];
  stub.perDay = 3;
  stub.failDays.clear();
  stub.empty.clear();
  const first = await runReg({ from: "2026-01-05", to: "2026-01-07" });
  assert.equal(first.status, "success");
  assert.equal(first.rowsInserted, 9);
  assert.equal(first.coveredThrough, "2026-01-07");
  assert.equal(await db.company.count({ where: { companyNumber: { startsWith: "ST" } } }), 9);
  const queued = await db.officerSyncJob.findMany({ where: { company: { companyNumber: { startsWith: "ST" } } } });
  assert.equal(queued.length, 9);
  assert.ok(queued.every((j) => j.reason === "new_registration" && j.priority === 5 && j.status === "queued"));

  const again = await runReg({ from: "2026-01-05", to: "2026-01-07" }); // overlapping / repeated window
  assert.equal(again.rowsInserted, 0);
  assert.equal(again.rowsUpdated, 9);
  assert.equal(await db.company.count({ where: { companyNumber: { startsWith: "ST" } } }), 9);
  assert.equal(await db.officerSyncJob.count({ where: { company: { companyNumber: { startsWith: "ST" } } } }), 9);
});

test("new registrations: a failed day is NOT covered, the checkpoint stays on the last good day, and the next run retries it", async () => {
  await cleanup();
  stub.perDay = 2;
  stub.failDays = new Set(["2026-01-09"]);
  const r = await runReg({ from: "2026-01-08", to: "2026-01-10" });
  assert.equal(r.status, "partial"); // never "success" for an incomplete window
  assert.equal(r.coveredThrough, "2026-01-08");
  assert.match(r.error ?? "", /stub failure|400/);
  const run = await db.ingestionRun.findUniqueOrThrow({ where: { id: r.runId } });
  assert.equal(run.checkpoint, "2026-01-08");
  assert.equal(await db.company.count({ where: { companyNumber: { startsWith: "ST20260110" } } }), 0); // the day AFTER the failure was not skipped ahead to

  stub.failDays.clear();
  const retry = await runReg({ from: "2026-01-08", to: "2026-01-10" });
  assert.equal(retry.status, "success");
  assert.equal(retry.coveredThrough, "2026-01-10");
  assert.equal(await db.company.count({ where: { companyNumber: { startsWith: "ST" } } }), 6);
});

test("new registrations: a finished day with an empty answer is refused, not silently marked covered", async () => {
  await cleanup();
  stub.perDay = 2;
  stub.failDays.clear();
  stub.empty = new Set(["2026-01-12"]);
  stub.perDay = 0; // nothing generated: the stub answers 404 for the day
  const r = await runReg({ from: "2026-01-12", to: "2026-01-12" });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /no registrations for a finished day/);
  stub.empty.clear();
});

test("new registrations: a genuinely empty stretch (like 13-14 June 2026, absent from Companies House's own file) is covered once the search is proven healthy by a control read", async () => {
  await cleanup();
  stub.perDay = 0;
  stub.failDays.clear();
  stub.empty.clear();
  stub.fixtures = [item("ZT800001", "active", "ltd", "2026-01-10"), item("ZT800002", "active", "ltd", "2026-01-11")]; // the week before has data
  const r = await runReg({ from: "2026-01-12", to: "2026-01-13" }); // two empty days in a row
  assert.equal(r.status, "success", r.error ?? "");
  assert.equal(r.coveredThrough, "2026-01-13"); // the checkpoint moves past the genuine gap instead of stalling forever
  assert.equal(r.rowsInserted, 0);
  stub.fixtures = [];
});

test("new registrations: an empty day that is too recent is still refused (index lag), and so is an empty day when the whole preceding week is empty too", async () => {
  await cleanup();
  stub.perDay = 0;
  stub.failDays.clear();
  stub.empty.clear();
  const dayOf = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
  stub.fixtures = [item("ZT800003", "active", "ltd", dayOf(5))]; // the preceding week has data, but yesterday is empty
  const recent = await runReg({ from: dayOf(1), to: dayOf(1) });
  assert.equal(recent.status, "failed");
  assert.match(recent.error ?? "", /too recent/);
  stub.fixtures = []; // nothing anywhere: an old empty day with an empty control window is not trusted
  const broken = await runReg({ from: "2026-01-12", to: "2026-01-12" });
  assert.equal(broken.status, "failed");
  assert.match(broken.error ?? "", /search looks broken|no registrations for a finished day/);
});

test("new registrations: a day larger than one response page is read in full through the split, with a proven total and no duplicates", async () => {
  await cleanup();
  stub.perDay = 0;
  stub.page = 3500; // the stub can return at most 3,500 rows per response, like the real API's page limit
  stub.fixtures = [
    ...Array.from({ length: 3000 }, (_, i) => item(`ZT1${String(i).padStart(5, "0")}`, "active", "ltd", "2026-01-14")),
    ...Array.from({ length: 1000 }, (_, i) => item(`ZT2${String(i).padStart(5, "0")}`, "dissolved", "ltd", "2026-01-14", "2026-01-20")),
  ];
  const r = await runReg({ from: "2026-01-14", to: "2026-01-14" });
  assert.equal(r.status, "success");
  assert.equal(r.rowsRead, 4000);
  assert.equal(r.rowsInserted, 4000);
  assert.equal(await db.company.count({ where: { companyNumber: { startsWith: "ZT" } } }), 4000);
  assert.ok(stub.requests.some((q) => q.company_status === "active")); // proves the split path was used
  // A broken split (the stub hides some rows) must NOT be reported as covered.
  stub.page = 5000;
  stub.fixtures = stub.fixtures.map((f) => (f.company_number.startsWith("ZT2") ? { ...f, company_status: "brand-new-status" } : f));
  stub.page = 3500;
  const bad = await runReg({ from: "2026-01-14", to: "2026-01-14" });
  assert.notEqual(bad.status, "success");
  assert.match(bad.error ?? "", /not claiming coverage/);
  stub.fixtures = [];
  stub.page = 5000;
});

// ---- B: dissolved + status refresh end to end against the stub ------------------------------------------------------------------
test("dissolved refresh: updates stored companies and inserts new dissolved ones, leaves everything else alone, and is idempotent", async () => {
  await cleanup();
  stub.perDay = 0;
  stub.failAll = false;
  stub.page = 5000;
  const today = new Date().toISOString().slice(0, 10);
  const a = await makeCompany({ companyNumber: "ZT900001", name: "KEEP MY NAME LTD", status: "active", registeredCity: "Leeds", officersCoverage: "full", directorCount: 2 });
  const b = await makeCompany({ companyNumber: "ZT900002", name: "UNRELATED LTD", status: "active" });
  stub.fixtures = [
    item("ZT900001", "dissolved", "ltd", "2015-06-15", today), // A dissolved today
    item("ZT900003", "dissolved", "ltd", "2012-03-01", today), // C: not stored yet
  ];
  const { runDissolvedRefresh, loadDissolvedRefreshState } = await import("../../src/lib/jobs/dissolvedRefresh");

  const dry = await (await import("../../src/lib/companies-house/dissolvedImport")).importDissolved({ adaptive: true, dissolvedSince: today, dryRun: true });
  assert.equal(dry.rowsInserted, 1); // prediction only
  assert.equal(dry.rowsUpdated, 1);
  assert.equal(await db.company.count({ where: { companyNumber: "ZT900003" } }), 0); // a dry run writes nothing

  const r = await runDissolvedRefresh();
  assert.equal(r.status, "success");
  assert.equal(r.rowsInserted, 1);
  assert.equal(r.rowsUpdated, 1);
  const a2 = await db.company.findUniqueOrThrow({ where: { companyNumber: "ZT900001" } });
  assert.equal(a2.status, "dissolved");
  assert.equal(a2.name, "KEEP MY NAME LTD"); // only status / dissolution date are touched
  assert.equal(a2.registeredCity, "Leeds");
  assert.equal(a2.officersCoverage, "full");
  assert.equal(a2.directorCount, 2);
  assert.equal(a2.id, a.id); // same row, relationships intact
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: "ZT900002" } })).status, "active");
  assert.equal(b.status, "active");

  const state = await loadDissolvedRefreshState();
  assert.equal(state.doneToday, true);
  assert.equal(state.attemptsToday, 1);

  const second = await runDissolvedRefresh();
  assert.equal(second.rowsInserted, 0);
  assert.equal(second.rowsUpdated, 0);
});

test("dissolved refresh: a Companies House failure is recorded as failed, counted as an attempt, and never as done", async () => {
  await cleanup();
  stub.failAll = true;
  const { runDissolvedRefresh, loadDissolvedRefreshState } = await import("../../src/lib/jobs/dissolvedRefresh");
  const r = await runDissolvedRefresh();
  assert.notEqual(r.status, "success");
  const state = await loadDissolvedRefreshState();
  assert.equal(state.doneToday, false);
  assert.equal(state.attemptsToday, 1);
  const run = await db.ingestionRun.findFirstOrThrow({ where: { kind: "advanced_search", inputName: { contains: "|dissolved>=" } }, orderBy: { startedAt: "desc" } });
  assert.notEqual(run.status, "success");
  assert.ok(run.errorMessage);
  stub.failAll = false;
});

test("status reconcile: a stored company now in liquidation is brought in line, and only on the weekly schedule", async () => {
  await cleanup();
  stub.fixtures = [item("ZT900010", "liquidation", "ltd", "2016-01-01")];
  await makeCompany({ companyNumber: "ZT900010", status: "active" });
  const { runStatusReconcile, loadStatusReconcileState, statusReconcileDue, loadRefreshConfig } = await import("../../src/lib/jobs/dissolvedRefresh");
  const r = await runStatusReconcile("liquidation");
  assert.equal(r.status, "success");
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: "ZT900010" } })).status, "liquidation");
  const st = await loadStatusReconcileState("liquidation");
  assert.ok(st.lastSuccessAt);
  const cfg = { ...loadRefreshConfig({ STATUS_RECONCILE_ENABLED: "1" }), hourUtc: 0 };
  assert.equal(statusReconcileDue(st, new Date(), cfg), false); // just done: not due again for a week
  assert.equal((await loadStatusReconcileState("administration")).lastSuccessAt, null); // independent per status
  stub.fixtures = [];
});

// ---- freshness + health ---------------------------------------------------------------------------------------------------------
test("freshness: a failed or partial run never supplies a 'last updated' timestamp", async () => {
  await cleanup();
  await db.ingestionRun.deleteMany({ where: { kind: { in: ["new_registrations", "bulk_csv"] } } });
  const { getDataFreshness, getIngestionFreshness } = await import("../../src/lib/data/freshness");
  const t = new Date(Date.now() - 3_600_000);
  const earlier = new Date(t.getTime() - 60_000); // distinct start times: "latest" is decided by startedAt, so a tie would be arbitrary
  await db.ingestionRun.create({ data: { kind: "new_registrations", status: "failed", startedAt: earlier, finishedAt: earlier, errorMessage: "boom" } });
  await db.ingestionRun.create({ data: { kind: "new_registrations", status: "partial", startedAt: t, finishedAt: t } });
  let f = await getIngestionFreshness();
  assert.equal(f.registrations.lastSuccessAt, null);
  assert.equal(f.registrations.latestRun?.status, "partial");
  assert.equal((await getDataFreshness()).lastUpdated === null || (await getDataFreshness()).lastUpdated!.getTime() !== t.getTime(), true);
  const good = new Date(Date.now() - 600_000);
  await db.ingestionRun.create({ data: { kind: "new_registrations", status: "success", startedAt: good, finishedAt: good } });
  f = await getIngestionFreshness();
  assert.equal(f.registrations.lastSuccessAt?.getTime(), good.getTime());
  await db.ingestionRun.deleteMany({ where: { kind: "new_registrations" } });
});

test("/api/health: a Super Admin sees scheduler liveness and per-source freshness; a stopped scheduler degrades the status", async () => {
  await cleanup();
  const sa = await sessionFor("SUPER_ADMIN");
  const { acquireSchedulerLease } = await lease();
  const row = await acquireSchedulerLease("health:1", ["new_registrations"]);
  let res = await api(sa, "/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.json.jobs.scheduler.alive, true);
  assert.ok(res.json.jobs.sources && "registrations" in res.json.jobs.sources && "dissolved" in res.json.jobs.sources && "officers" in res.json.jobs.sources);
  await db.ingestionRun.update({ where: { id: row.id }, data: { heartbeatAt: new Date(Date.now() - 30 * 60_000) } });
  res = await api(sa, "/api/health");
  assert.equal(res.json.jobs.scheduler.alive, false);
  assert.ok(res.json.jobs.reasons.includes("scheduler_down"));
  assert.equal(res.json.status, "degraded");
  const pub = await api(null, "/api/health");
  assert.equal(pub.json.jobs, undefined); // the public status stays minimal
});

// ---- real scheduler processes ------------------------------------------------------------------------------------------------
const TSX = path.resolve("node_modules/tsx/dist/cli.mjs");
interface Child {
  proc: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}
function startScheduler(env: Record<string, string>, args: string[] = []): Child {
  let buf = "";
  const proc = spawn(process.execPath, [TSX, "scripts/scheduler.ts", ...args], {
    env: {
      ...process.env,
      // Everything defaults OFF; each test enables only what it needs. COMPANIES_HOUSE_* point at the local stub.
      NEW_REGISTRATIONS_ENABLED: "0",
      DAILY_MAX_ATTEMPTS: "0",
      OFFICER_WORKER_ENABLED: "0",
      OFFICER_CRAWL_ENABLED: "0",
      STREAM_WORKER_ENABLED: "0",
      MONTHLY_INGEST_ENABLED: "0",
      DISSOLVED_REFRESH_ENABLED: "0",
      STATUS_RECONCILE_ENABLED: "0",
      LOG_FORMAT: "text",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d) => (buf += d));
  proc.stderr?.on("data", (d) => (buf += d));
  const exited = new Promise<number | null>((resolve) => proc.on("exit", (c) => resolve(c)));
  return { proc, out: () => buf, exited };
}
async function waitFor(cond: () => Promise<boolean> | boolean, ms = 60_000, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${label}`);
}
const killTree = (c: Child) => {
  try {
    c.proc.kill();
  } catch {
    /* already gone */
  }
};

test("scheduler process: in production it refuses to start without the database expectation, and with a wrong one (exit code 2), writing nothing", { timeout: 120_000 }, async () => {
  await cleanup();
  const before = await db.ingestionRun.count({ where: { kind: "scheduler" } });
  const noExpectation = startScheduler({ NODE_ENV: "production" });
  assert.equal(await noExpectation.exited, 2);
  assert.match(noExpectation.out(), /REFUSED to start/);
  const wrong = startScheduler({ NODE_ENV: "production", SCHEDULER_EXPECTED_DB_HOST: "db.example.invalid", SCHEDULER_EXPECTED_DB_NAME: "director_ltd" });
  assert.equal(await wrong.exited, 2);
  assert.equal(await db.ingestionRun.count({ where: { kind: "scheduler" } }), before); // it never touched the database
  const url = new URL(process.env.DATABASE_URL!);
  const right = startScheduler({ NODE_ENV: "production", SCHEDULER_EXPECTED_DB_HOST: url.hostname, SCHEDULER_EXPECTED_DB_NAME: decodeURIComponent(url.pathname.slice(1)) }, ["--once"]);
  assert.equal(await right.exited, 0);
  assert.ok(!right.out().includes(url.password)); // secrets never reach the log
});

test("scheduler process: --once runs the due jobs, records the heartbeat row, and exits 0 after releasing its lease", { timeout: 180_000 }, async () => {
  await cleanup();
  stub.fixtures = [item("ZT900020", "dissolved", "ltd", "2014-02-02", new Date().toISOString().slice(0, 10))];
  stub.perDay = 1;
  stub.failDays.clear();
  stub.empty.clear();
  stub.failAll = false;
  stub.requests.length = 0;
  const c = startScheduler(
    { COMPANIES_HOUSE_REST_BASE_URL: baseUrl, COMPANIES_HOUSE_API_KEY: "test-rest-key", CH_QUOTA_PACING: "0", NEW_REGISTRATIONS_ENABLED: "1", DISSOLVED_REFRESH_ENABLED: "1", DISSOLVED_REFRESH_UTC_HOUR: "0" },
    ["--once"]
  );
  assert.equal(await c.exited, 0, c.out());
  const sched = await db.ingestionRun.findFirstOrThrow({ where: { kind: "scheduler" }, orderBy: { startedAt: "desc" } });
  assert.equal(sched.status, "success");
  assert.match(sched.statsJson ?? "", /new_registrations/);
  assert.match(sched.statsJson ?? "", /dissolved_refresh/);
  assert.equal((await db.ingestionRun.findFirstOrThrow({ where: { kind: "new_registrations" }, orderBy: { startedAt: "desc" } })).status, "success");
  assert.equal((await db.ingestionRun.findFirstOrThrow({ where: { kind: "advanced_search", inputName: { contains: "|dissolved>=" } } })).status, "success");
  assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: "ZT900020" } })).status, "dissolved");
  // Run it again straight away: everything is already done, so no company-data request is made.
  stub.requests.length = 0;
  const regRunsBefore = await db.ingestionRun.count({ where: { kind: "new_registrations" } });
  const dissolvedRunsBefore = await db.ingestionRun.count({ where: { kind: "advanced_search" } });
  const again = startScheduler(
    { COMPANIES_HOUSE_REST_BASE_URL: baseUrl, COMPANIES_HOUSE_API_KEY: "test-rest-key", CH_QUOTA_PACING: "0", NEW_REGISTRATIONS_ENABLED: "1", DISSOLVED_REFRESH_ENABLED: "1", DISSOLVED_REFRESH_UTC_HOUR: "0" },
    ["--once"]
  );
  assert.equal(await again.exited, 0, again.out());
  assert.equal(await db.ingestionRun.count({ where: { kind: "new_registrations" } }), regRunsBefore); // restart-safe: not repeated inside the interval
  assert.equal(await db.ingestionRun.count({ where: { kind: "advanced_search" } }), dissolvedRunsBefore); // and not repeated the same UTC day
  stub.fixtures = [];
  stub.perDay = 0;
});

test("scheduler process: a second instance with the same jobs exits 3 while the first runs; a hard kill is taken over after the heartbeat expires; the stop file stops it gracefully", { timeout: 240_000 }, async () => {
  await cleanup();
  const stopFile = path.join(tmp, "stop-a");
  const env = { DAILY_MAX_ATTEMPTS: "1", DAILY_UPDATE_UTC_HOUR: "23" }; // owns "daily_update" but will not run it (hour not reached or already done)
  const a = startScheduler({ ...env, SCHEDULER_STOP_FILE: stopFile });
  await waitFor(async () => (await db.ingestionRun.count({ where: { kind: "scheduler", status: "running" } })) === 1, 60_000, "first scheduler lease");

  const b = startScheduler(env);
  assert.equal(await b.exited, 3, b.out()); // duplicate instance refused
  assert.match(b.out(), /already running the same job/);
  assert.equal(await db.ingestionRun.count({ where: { kind: "scheduler", status: "running" } }), 1);

  // A scheduler with a DISJOINT job set (no daily update) may share the database: this is the existing local layout.
  const other = startScheduler({ OFFICER_WORKER_ENABLED: "0", DAILY_MAX_ATTEMPTS: "0", NEW_REGISTRATIONS_ENABLED: "0", COMPANIES_HOUSE_API_KEY: "" });
  await waitFor(async () => (await db.ingestionRun.count({ where: { kind: "scheduler", status: "running" } })) === 2, 60_000, "disjoint scheduler lease");
  killTree(other);
  await other.exited;

  // Hard crash of A: SIGKILL-equivalent (no shutdown handler runs), so its row stays "running" until the heartbeat expires.
  killTree(a);
  await a.exited;
  const stale = await db.ingestionRun.findFirstOrThrow({ where: { kind: "scheduler", inputName: { not: null }, status: "running", statsJson: { contains: "daily_update" } } });
  const early = startScheduler(env);
  assert.equal(await early.exited, 3); // too soon: the dead instance still looks alive
  await db.ingestionRun.update({ where: { id: stale.id }, data: { heartbeatAt: new Date(Date.now() - 3 * 60_000) } }); // 3 minutes of silence
  const replacement = startScheduler({ ...env, SCHEDULER_STOP_FILE: stopFile });
  await waitFor(async () => (await db.ingestionRun.findUniqueOrThrow({ where: { id: stale.id } })).status === "failed", 60_000, "stale lease reconciled");
  await waitFor(async () => (await db.ingestionRun.count({ where: { kind: "scheduler", status: "running", statsJson: { contains: "daily_update" } } })) === 1, 60_000, "replacement lease");

  // Graceful stop through the stop file: exit 0 and the lease is released ("success") with the reason recorded.
  fs.writeFileSync(stopFile, "stop");
  assert.equal(await replacement.exited, 0, replacement.out());
  const last = await db.ingestionRun.findFirstOrThrow({ where: { kind: "scheduler", status: "success", statsJson: { contains: "stop file" } } });
  assert.ok(last.finishedAt);
  // The only lease still "running" is the disjoint scheduler that was hard-killed above (it never got to release it); it owns
  // no daily_update, and the real reconciler will mark it failed once its heartbeat is two minutes old.
  assert.equal(await db.ingestionRun.count({ where: { kind: "scheduler", status: "running", statsJson: { contains: "daily_update" } } }), 0);
});

// ---- persistent mode and the Windows supervisor ---------------------------------------------------------------------------------
test("scheduler process (persistent mode): its own tick runs the due jobs without anyone asking, and the stop file ends it gracefully", { timeout: 240_000 }, async () => {
  await cleanup();
  await db.ingestionRun.deleteMany({ where: { kind: "new_registrations" } }); // nothing counts as "done recently"
  stub.fixtures = [item("ZT900040", "dissolved", "ltd", "2013-04-04", new Date().toISOString().slice(0, 10))];
  stub.perDay = 1;
  stub.failDays.clear();
  stub.empty.clear();
  stub.failAll = false;
  const stopFile = path.join(tmp, "stop-persistent");
  const c = startScheduler({
    COMPANIES_HOUSE_REST_BASE_URL: baseUrl,
    COMPANIES_HOUSE_API_KEY: "test-rest-key",
    CH_QUOTA_PACING: "0",
    NEW_REGISTRATIONS_ENABLED: "1",
    DISSOLVED_REFRESH_ENABLED: "1",
    DISSOLVED_REFRESH_UTC_HOUR: "0",
    SCHEDULER_STOP_FILE: stopFile,
  });
  try {
    await waitFor(async () => (await db.ingestionRun.count({ where: { kind: "new_registrations", status: "success" } })) >= 1, 120_000, "scheduled new-registrations run");
    await waitFor(async () => (await db.ingestionRun.count({ where: { kind: "advanced_search", inputName: { contains: "|dissolved>=" }, status: "success" } })) >= 1, 120_000, "scheduled dissolved refresh");
    assert.equal((await db.company.findUniqueOrThrow({ where: { companyNumber: "ZT900040" } })).status, "dissolved");
    assert.equal((await db.ingestionRun.findFirstOrThrow({ where: { kind: "scheduler", status: "running" } })).inputName?.includes(":"), true); // alive, holding its lease
    fs.writeFileSync(stopFile, "stop");
    assert.equal(await c.exited, 0, c.out());
    assert.equal(await db.ingestionRun.count({ where: { kind: "scheduler", status: "running" } }), 0, "lease released on a graceful stop");
  } finally {
    killTree(c);
    stub.fixtures = [];
    stub.perDay = 0;
  }
});

test("supervisor (Windows script, real process): starts the scheduler, a second supervisor exits at once, a killed scheduler is restarted by its exit code, and the stop file ends it", { timeout: 300_000, skip: process.platform !== "win32" ? "the PowerShell supervisor only runs on Windows" : false }, async () => {
  await cleanup();
  const dir = fs.mkdtempSync(path.join(tmp, "sup-"));
  const stopFile = path.join(dir, "supervisor.stop");
  const url = new URL(process.env.DATABASE_URL!);
  // Everything is OFF except "stream", which holds a lease but does nothing: the stream key is blanked so no real stream is ever contacted.
  const env = {
    ...process.env,
    NEW_REGISTRATIONS_ENABLED: "0",
    DAILY_MAX_ATTEMPTS: "0",
    OFFICER_WORKER_ENABLED: "0",
    MONTHLY_INGEST_ENABLED: "0",
    DISSOLVED_REFRESH_ENABLED: "0",
    STATUS_RECONCILE_ENABLED: "0",
    STREAM_WORKER_ENABLED: "1",
    COMPANIES_HOUSE_STREAM_KEY: "",
    SCHEDULER_EXPECTED_DB_HOST: url.hostname,
    SCHEDULER_EXPECTED_DB_NAME: decodeURIComponent(url.pathname.slice(1)),
  };
  const launch = () =>
    spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.resolve("scripts/run-production-scheduler.ps1"), "-LogDir", dir, "-StopFile", stopFile], { env, stdio: "ignore", windowsHide: true });
  const exitOf = (p: ChildProcess) => new Promise<number | null>((resolve) => p.on("exit", (c) => resolve(c)));
  const logText = () => (fs.existsSync(path.join(dir, "scheduler.log")) ? fs.readFileSync(path.join(dir, "scheduler.log"), "utf8") : "");
  const sup = launch();
  const supExit = exitOf(sup);
  try {
    await waitFor(async () => (await db.ingestionRun.count({ where: { kind: "scheduler", status: "running", statsJson: { contains: "stream" } } })) === 1, 120_000, "supervised scheduler lease");
    assert.match(logText(), /supervisor: starting scheduler/);
    assert.match(logText(), /database 127\.0\.0\.1:\d+\/director_test/); // the scheduler's own start-up line names the (scratch) database, never a password
    assert.ok(!logText().includes(url.password));

    const second = launch(); // a second supervisor must find the lock and leave at once
    assert.equal(await exitOf(second), 0);
    assert.equal(await db.ingestionRun.count({ where: { kind: "scheduler", status: "running" } }), 1);

    // Hard-kill the scheduler process itself (its lease row stays "running"): the supervisor must notice, and start another one.
    const row = await db.ingestionRun.findFirstOrThrow({ where: { kind: "scheduler", status: "running" } });
    const pid = Number(String(row.inputName).split(":").pop());
    process.kill(pid, "SIGKILL");
    await waitFor(() => (logText().match(/supervisor: starting scheduler/g) ?? []).length >= 2, 120_000, "supervisor restarting the scheduler");
    // The replacement is refused (the dead one's lease has not expired yet) with exit code 3: the supervisor backs off 2 minutes.
    await waitFor(() => /exited \(code 3\); restarting in 120 s/.test(logText()), 120_000, "exit code 3 back-off");

    fs.writeFileSync(stopFile, "stop");
    assert.equal(await supExit, 0);
    assert.match(logText(), /supervisor: stop file found, exiting/);
  } finally {
    try {
      fs.writeFileSync(stopFile, "stop");
    } catch {
      /* directory already gone */
    }
    try {
      sup.kill();
    } catch {
      /* already gone */
    }
  }
});

// ---- the scheduled monthly bulk file and the officer worker, run exactly as the scheduler runs them ---------------------------------
test("scheduler process: the monthly bulk job loads a newly PUBLISHED file once, never reloads it, and starts a fresh load when an interrupted run cannot be resumed", { timeout: 240_000 }, async () => {
  const { REQUIRED_COLUMNS } = await import("../../src/lib/companies-house/csv/mapping");
  await cleanup();
  const now = new Date();
  const snapshot = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = Array.from({ length: 5 }, (_, i) => ({
    CompanyName: `MONTHLY STUB ${i} LTD`,
    CompanyNumber: `ZT95000${i}`,
    "RegAddress.AddressLine1": `${i} Test Road`,
    "RegAddress.PostTown": "LEEDS",
    "RegAddress.PostCode": "LS1 4AB",
    CompanyCategory: "Private Limited Company",
    CompanyStatus: "Active",
    IncorporationDate: "11/09/2012",
  } as Record<string, string>));
  const csv = [REQUIRED_COLUMNS.join(","), ...rows.map((r) => REQUIRED_COLUMNS.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n";
  // A local stand-in for download.companieshouse.gov.uk: only the CURRENT month's file is "published".
  const published = http.createServer((req, res) => {
    const ok = req.url === `/BasicCompanyDataAsOneFile-${snapshot}.zip`;
    if (!ok) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-length": Buffer.byteLength(csv), "content-type": "application/octet-stream" });
    res.end(req.method === "HEAD" ? undefined : csv);
  });
  await new Promise<void>((r) => published.listen(0, "127.0.0.1", r));
  const env = {
    MONTHLY_INGEST_ENABLED: "1",
    MONTHLY_INGEST_DAY: "1",
    MONTHLY_INGEST_UTC_HOUR: "0",
    CH_BULK_DOWNLOAD_BASE_URL: `http://127.0.0.1:${(published.address() as AddressInfo).port}`,
    INGEST_DOWNLOAD_DIR: path.join(tmp, "monthly-cache"),
  };
  try {
    // Earlier suites loaded their own sample files into this scratch database: forget which snapshot they recorded.
    await db.$executeRawUnsafe(`UPDATE "IngestionRun" SET "statsJson" = NULL WHERE kind = 'bulk_csv'`);
    const bulkRuns = () => db.ingestionRun.count({ where: { kind: "bulk_csv" } });

    const first = startScheduler(env, ["--once", "--with-monthly"]);
    assert.equal(await first.exited, 0, first.out());
    assert.match(first.out(), /Running monthly bulk ingest/);
    const run1 = await db.ingestionRun.findFirstOrThrow({ where: { kind: "bulk_csv" }, orderBy: { startedAt: "desc" } });
    assert.equal(run1.status, "success", run1.errorMessage ?? "");
    assert.equal((JSON.parse(run1.statsJson ?? "{}") as { snapshotDate?: string }).snapshotDate, snapshot);
    assert.equal(await db.company.count({ where: { companyNumber: { startsWith: "ZT9500" } } }), 5);

    const afterFirst = await bulkRuns();
    const second = startScheduler(env, ["--once", "--with-monthly"]); // same published file: nothing to do
    assert.equal(await second.exited, 0, second.out());
    assert.equal(await bulkRuns(), afterFirst, "a published file that is already loaded must not be loaded again");

    // An interrupted run exists (failed, with a checkpoint) but it belongs to a DIFFERENT file, and a newer snapshot is due.
    await db.ingestionRun.update({ where: { id: run1.id }, data: { statsJson: JSON.stringify({ snapshotDate: "2000-01-01" }) } });
    await db.ingestionRun.create({ data: { kind: "bulk_csv", status: "failed", checkpoint: "3", inputFingerprint: "some-other-file.zip|1|1", errorMessage: "interrupted" } });
    const before = await bulkRuns();
    const third = startScheduler(env, ["--once", "--with-monthly"]);
    assert.equal(await third.exited, 0, third.out());
    assert.match(third.out(), /Cannot resume/);
    assert.equal(await bulkRuns(), before + 1, "a fresh monthly load was started");
    const newest = await db.ingestionRun.findFirstOrThrow({ where: { kind: "bulk_csv" }, orderBy: { startedAt: "desc" } });
    assert.equal(newest.status, "success", newest.errorMessage ?? "");
  } finally {
    published.close();
  }
});

test("scheduler process: the officer worker processes queued work, only through the quota gate and the daily cap, and finishes the job it claimed", { timeout: 180_000 }, async () => {
  await cleanup();
  const { enqueueOfficerJobs, OFFICER_PRIORITY } = await import("../../src/lib/companies-house/officerQueue");
  await db.officerSyncJob.deleteMany(); // scratch database: leftovers from earlier suites would compete for the small cap below
  await db.ingestionRun.deleteMany({ where: { kind: "officer_backfill" } }); // the cap remembers what earlier runs spent today
  const co = await makeCompany({ companyNumber: "ZT960001" });
  await enqueueOfficerJobs([co.id], { priority: OFFICER_PRIORITY.REPORT, reason: "report" });
  stub.officerRequests.length = 0;
  const c = startScheduler(
    { OFFICER_WORKER_ENABLED: "1", OFFICER_CRAWL_ENABLED: "0", OFFICER_DAILY_REQUEST_CAP: "40", ONCE_OFFICER_MINUTES: "2", COMPANIES_HOUSE_REST_BASE_URL: baseUrl, COMPANIES_HOUSE_API_KEY: "test-rest-key", CH_QUOTA_PACING: "0" },
    ["--once"]
  );
  assert.equal(await c.exited, 0, c.out());
  assert.ok(stub.officerRequests.includes("ZT960001"), "the worker asked Companies House (the local stub) about the queued company");
  assert.equal(await db.officerSyncJob.findUnique({ where: { companyId: co.id } }), null, "the finished job leaves the queue");
  assert.ok((await db.company.findUniqueOrThrow({ where: { id: co.id } })).officersFetchedAt, "officer data is marked as fetched");
  assert.ok(stub.officerRequests.length <= 40, "never more than the configured daily cap");
  const sched = await db.ingestionRun.findFirstOrThrow({ where: { kind: "scheduler" }, orderBy: { startedAt: "desc" } });
  assert.match(sched.statsJson ?? "", /officer_worker/);
});

// ---- officer queue recovery stays intact when the scheduler restarts ---------------------------------------------------------------
test("officer queue: jobs leased by a killed scheduler's worker return to the queue after the lease expires, without charging an attempt", async () => {
  await cleanup();
  const { enqueueOfficerJobs, claimOfficerJobs, releaseExpiredLeases, OFFICER_PRIORITY } = await import("../../src/lib/companies-house/officerQueue");
  const co = await makeCompany({ companyNumber: "ZT900030" });
  await enqueueOfficerJobs([co.id], { priority: OFFICER_PRIORITY.PREFETCH, reason: "new_registration" });
  // The scratch database is shared with earlier suites, whose leftover queued jobs sort first (priority, then due time): claim wide
  // enough that this company's job is certainly among those leased.
  const claimed = await claimOfficerJobs("dead-worker", { limit: 100_000, priorityMax: 99 });
  assert.ok(claimed.some((j) => j.companyNumber === "ZT900030"));
  const job = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: co.id } });
  assert.equal(job.status, "leased");
  await db.officerSyncJob.update({ where: { companyId: co.id }, data: { leaseUntil: new Date(Date.now() - 60_000) } }); // the worker died; its lease lapsed
  assert.ok((await releaseExpiredLeases()) >= 1);
  const back = await db.officerSyncJob.findUniqueOrThrow({ where: { companyId: co.id } });
  assert.equal(back.status, "queued");
  assert.equal(back.attempts, job.attempts); // no attempt charged
  await (await import("../../src/lib/companies-house/officerQueue")).releaseWorkerLeases("dead-worker"); // hand every other leftover job back untouched
});
