// The dissolved-company random sample, end to end against the SCRATCH database and a local MOCK Companies House server (no live call is ever made).
// Years 2031-2036 are used for the test companies so that nothing else in the database can take part.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { db, makeCompany } from "./helpers";

type Mode = "many" | "one" | "404" | "zero" | "bad400";
const modes = new Map<string, Mode>();
const hits = new Map<string, number>();
let server: http.Server;
type Lib = typeof import("../../src/lib/companies-house/dissolvedSample");
let lib: Lib;
const created: string[] = [];

const person = (n: number, role: string, resigned = false) => ({ name: `PERSON ${n}`, officer_role: role, appointed_on: "2012-01-01", ...(resigned ? { resigned_on: "2014-01-01" } : {}), links: { officer: { appointments: `/officers/ID${n}/appointments` } } });

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "X-Ratelimit-Remain": "500", "X-Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 300) });
      res.end(JSON.stringify(body));
    };
    const m = /^\/company\/([^/]+)(\/officers)?$/.exec(url.pathname);
    if (!m) return send(404, {});
    const [, num, officers] = m;
    const mode = modes.get(num) ?? "zero";
    if (!officers) return send(200, { company_name: `MOCK ${num}`, company_number: num, company_status: "dissolved", type: "ltd" });
    if (mode === "404") return send(404, {});
    if (mode === "bad400") return send(400, { error: "bad request" });
    if (mode === "one") return send(200, { items: [person(1, "director"), person(2, "secretary")], total_results: 2 });
    if (mode === "many") return send(200, { items: [person(1, "director"), person(2, "corporate-director"), person(3, "llp-member"), person(4, "secretary"), person(5, "director", true)], total_results: 5 });
    return send(200, { items: [], total_results: 0 });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.COMPANIES_HOUSE_API_KEY = "test-rest-key";
  process.env.COMPANIES_HOUSE_REST_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  lib = await import("../../src/lib/companies-house/dissolvedSample");
});

after(async () => {
  await db.company.deleteMany({ where: { id: { in: created } } }); // the sample rows and director rows go with them (cascade)
  await new Promise<void>((r) => server.close(() => r()));
  await db.$disconnect();
});

const tag = String(Date.now() % 1_000_000);
let counter = 0;
async function mk(year: number, over: Record<string, unknown> = {}, mode?: Mode) {
  const number = `DS${tag}${String(++counter).padStart(3, "0")}`;
  const c = await makeCompany({ companyNumber: number, status: "dissolved", dissolutionDate: new Date(`${year}-06-15T00:00:00Z`), ...over });
  created.push(c.id);
  modes.set(number, mode ?? (counter % 4 === 0 ? "404" : counter % 4 === 1 ? "many" : counter % 4 === 2 ? "one" : "zero"));
  return c;
}
const ROLES = ["director", "corporate-director", "nominee-director", "corporate-nominee-director", "llp-member", "llp-designated-member", "corporate-llp-member", "corporate-llp-designated-member"];
const ledgerTotal = async () => (await db.chRequestStat.aggregate({ _sum: { requests: true } }))._sum.requests ?? 0;
const mockCalls = () => [...hits.entries()].filter(([p]) => created.length && p.startsWith("/company/DS" + tag)).reduce((s, [, n]) => s + n, 0);

test("draw: a truly random, never-checked, per-year sample; idempotent; existing data untouched", async () => {
  const pre: string[] = [];
  for (let i = 0; i < 60; i++) await mk(2031);
  for (let i = 0; i < 45; i++) await mk(2032);
  for (let i = 0; i < 3; i++) {
    const c = await mk(2031, { officersCoverage: "full", directorCount: 2, officersFetchedAt: new Date() });
    for (const role of ["director", "secretary"]) await db.director.create({ data: { companyId: c.id, name: `KEEP ${role}`, role, officerId: `K${tag}${c.id.slice(-5)}${role}`, source: "rest" } });
    pre.push(c.id);
  }
  const d1 = await lib.drawSample({ perYear: 40, batch: "t1", years: [2031, 2032] });
  assert.deepEqual(d1.map((x) => [x.year, x.frame, x.existing, x.drawn]), [[2031, 60, 0, 40], [2032, 45, 0, 40]], "frame = the never-checked companies only (the 3 already-checked ones are not in it)");
  const rows = await db.dissolvedSample.findMany({ where: { stratum: { in: [2031, 2032] } }, include: { company: true } });
  assert.equal(rows.length, 80);
  assert.equal(new Set(rows.map((r) => r.companyId)).size, 80, "no company twice");
  for (const r of rows) {
    assert.equal(r.company.status, "dissolved");
    assert.equal(r.company.officersCoverage, "none", "only never-checked companies are drawn");
    assert.equal(r.company.dissolutionDate!.getUTCFullYear(), r.stratum, "within its own dissolution year");
    assert.ok(!pre.includes(r.companyId));
    assert.equal(r.frameSize, r.stratum === 2031 ? 60 : 45);
    assert.deepEqual([r.status, r.kind, r.batch], ["selected", "full", "t1"]);
  }
  // random, not "the first N": compare with the id order of the 2031 frame
  const frame2031 = (await db.company.findMany({ where: { id: { in: created }, officersCoverage: "none", dissolutionDate: { gte: new Date("2031-01-01"), lt: new Date("2032-01-01") } }, select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id);
  const picked = new Set(rows.filter((r) => r.stratum === 2031).map((r) => r.companyId));
  assert.notDeepEqual([...picked].sort(), frame2031.slice(0, 40), "not simply the lowest ids");
  assert.notDeepEqual([...picked].sort(), frame2031.slice(-40), "not simply the highest ids");
  assert.ok(frame2031.slice(0, 30).some((id) => picked.has(id)) && frame2031.slice(30).some((id) => picked.has(id)), "spread over the whole frame");
  // idempotent
  const d2 = await lib.drawSample({ perYear: 40, batch: "t2", years: [2031, 2032] });
  assert.deepEqual(d2.map((x) => x.drawn), [0, 0]);
  assert.equal(await db.dissolvedSample.count({ where: { stratum: { in: [2031, 2032] } } }), 80);
  // a larger target only tops up
  const d3 = await lib.drawSample({ perYear: 45, batch: "t3", years: [2032] });
  assert.equal(d3[0].drawn, 5);
  assert.equal(await db.dissolvedSample.count({ where: { stratum: 2032 } }), 45, "the whole year is sampled when the target equals its frame");
  assert.equal(await db.company.count({ where: { id: { in: pre }, officersCoverage: "full" } }), 3);
});

test("run: controlled batches; the ledger records every request; no duplicate rows; existing data untouched; a re-run does nothing", async () => {
  const preIds = (await db.company.findMany({ where: { id: { in: created }, officersCoverage: "full" }, select: { id: true } })).map((c) => c.id);
  const preRows = await db.director.count({ where: { companyId: { in: preIds } } });
  const ledger0 = await ledgerTotal();
  const hits0 = mockCalls();
  const rep = await lib.runSampleBatches({ batchSize: 20, maxRequests: 10_000, dailyCap: null });
  assert.equal(rep.stopReason, "done");
  assert.equal(rep.attempted, 85);
  assert.equal(rep.failed, 0);
  assert.equal(rep.fetched + rep.unavailable, 85);
  const sent = mockCalls() - hits0;
  assert.equal(rep.requests, sent, "the run's own request count equals what the mock server received");
  assert.equal((await ledgerTotal()) - ledger0, sent, "the shared ledger recorded every one of those requests");
  // stored results: exactly the mock's officers, never duplicated; records = director + LLP-member rows
  const rows = await db.dissolvedSample.findMany({ where: { stratum: { in: [2031, 2032] } } });
  for (const r of rows) {
    const co = await db.company.findUniqueOrThrow({ where: { id: r.companyId } });
    const mode = modes.get(co.companyNumber)!;
    const total = await db.director.count({ where: { companyId: r.companyId } });
    const qual = await db.director.count({ where: { companyId: r.companyId, role: { in: ROLES } } });
    assert.equal(total, mode === "many" ? 5 : mode === "one" ? 2 : 0, `no duplicate officer rows (${mode})`);
    assert.equal(r.records, qual);
    assert.equal(r.records, mode === "many" ? 4 : mode === "one" ? 1 : 0);
    assert.equal(r.status, mode === "404" ? "unavailable" : "fetched");
    assert.equal(co.officersCoverage, mode === "404" ? "unavailable" : "full");
  }
  assert.equal(await db.director.count({ where: { companyId: { in: preIds } } }), preRows, "the already-checked companies' officer rows are untouched");
  // the estimator's inputs equal an independent recomputation
  const strata = (await lib.loadSampleStrata()).filter((s) => s.year === 2031 || s.year === 2032);
  for (const s of strata) {
    const mine = rows.filter((r) => r.stratum === s.year);
    assert.equal(s.n, mine.length);
    assert.equal(s.sum, mine.reduce((a, r) => a + (r.records ?? 0), 0));
    assert.equal(s.sumSq, mine.reduce((a, r) => a + (r.records ?? 0) ** 2, 0));
  }
  // re-run: nothing left, no request
  const again = await lib.runSampleBatches({ batchSize: 20, maxRequests: 10_000, dailyCap: null });
  assert.deepEqual([again.attempted, again.requests, again.stopReason], [0, 0, "done"]);
  assert.equal(mockCalls() - hits0, sent);
});

test("run respects the daily cap (with its reserve) and the request budget, and leaves the rest selected", async () => {
  for (let i = 0; i < 30; i++) await mk(2033, {}, "one");
  await lib.drawSample({ perYear: 30, batch: "t4", years: [2033] });
  const spent = await lib.requestsSpentToday();
  const capped = await lib.runSampleBatches({ batchSize: 1, maxRequests: 10_000, dailyCap: spent + 8, reserve: 4 });
  assert.equal(capped.stopReason, "cap");
  assert.ok(capped.requests <= 4 && capped.requests >= 2, `stopped at the cap minus its reserve: ${capped.requests} requests`);
  assert.ok((await db.dissolvedSample.count({ where: { stratum: 2033, status: "selected" } })) > 0, "the rest wait for the next run");
  assert.ok((await lib.requestsSpentToday()) <= spent + 8 - 4 + 1, "never beyond cap - reserve");
  const budget = await lib.runSampleBatches({ batchSize: 100, maxRequests: 6, dailyCap: null });
  assert.equal(budget.stopReason, "budget");
  assert.ok(budget.requests <= 6);
  const rest = await lib.runSampleBatches({ batchSize: 100, maxRequests: 10_000, dailyCap: null });
  assert.equal(rest.stopReason, "done");
  assert.equal(await db.dissolvedSample.count({ where: { stratum: 2033, status: "fetched" } }), 30);
});

test("a sampled company that somebody else checked first costs nothing and is not re-fetched; a failure is recorded, retried, never silently dropped", async () => {
  for (let i = 0; i < 6; i++) await mk(2034, {}, "one");
  await lib.drawSample({ perYear: 6, batch: "t5", years: [2034] });
  const rows = await db.dissolvedSample.findMany({ where: { stratum: 2034 }, include: { company: true } });
  const first = rows[0];
  await db.company.update({ where: { id: first.companyId }, data: { officersCoverage: "full", directorCount: 2, officersFetchedAt: new Date() } });
  for (const role of ["director", "llp-member", "secretary"]) await db.director.create({ data: { companyId: first.companyId, name: `X ${role}`, role, officerId: `X${tag}${role}`, source: "rest" } });
  const bad = rows[1];
  modes.set(bad.company.companyNumber, "bad400");
  const h0 = hits.get(`/company/${first.company.companyNumber}/officers`) ?? 0;
  const rep = await lib.runSampleBatches({ batchSize: 10, maxRequests: 1_000, dailyCap: null });
  assert.equal(rep.alreadyChecked, 1);
  assert.equal((hits.get(`/company/${first.company.companyNumber}/officers`) ?? 0), h0, "no request for a company that was already checked");
  const a = await db.dissolvedSample.findUniqueOrThrow({ where: { companyId: first.companyId } });
  assert.deepEqual([a.status, a.records], ["already_checked", 2], "uses what is stored: 2 director/LLP records, the secretary is not counted");
  assert.equal(await db.director.count({ where: { companyId: first.companyId } }), 3, "nothing replaced");
  // the failing company: recorded, retried up to 3 times, never silently dropped and never counted as a sample value
  assert.equal(rep.failed, 3);
  const f = await db.dissolvedSample.findUniqueOrThrow({ where: { companyId: bad.companyId } });
  assert.deepEqual([f.status, f.attempts, f.records], ["failed", 3, null]);
  assert.match(f.lastError ?? "", /400|bad request|Companies House/i);
  const n2034 = (await lib.loadSampleStrata()).find((x) => x.year === 2034)!;
  assert.equal(n2034.n, 5, "6 drawn - 1 failed = 5 resolved: the failure is reported, not folded into the mean");
  assert.equal(await db.company.count({ where: { id: bad.companyId, officersCoverage: "none" } }), 1, "the failed company's stored state is untouched");
});

test("tagPilot: fetched companies become pilot sample members with their stored results; unchecked ones are skipped; idempotent", async () => {
  const a = await mk(2035, { officersCoverage: "full", directorCount: 1, officersFetchedAt: new Date() }, "one");
  await db.director.createMany({ data: [{ companyId: a.id, name: "P1", role: "director", officerId: `P${tag}1`, source: "rest" }, { companyId: a.id, name: "P2", role: "secretary", officerId: `P${tag}2`, source: "rest" }] });
  const b = await mk(2035, { officersCoverage: "unavailable", officersFetchedAt: new Date() }, "404");
  const c = await mk(2035);
  const r1 = await lib.tagPilot([a.id, b.id, c.id]);
  assert.deepEqual([r1.tagged, r1.skipped], [2, [c.id]]);
  const rows = await db.dissolvedSample.findMany({ where: { stratum: 2035 }, orderBy: { status: "asc" } });
  assert.deepEqual(rows.map((r) => [r.kind, r.status, r.records]).sort(), [["pilot", "fetched", 1], ["pilot", "unavailable", 0]].sort());
  assert.deepEqual((await lib.tagPilot([a.id, b.id])).tagged, 0, "idempotent");
});
