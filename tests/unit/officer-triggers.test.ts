import { test } from "node:test";
import assert from "node:assert/strict";
import { allowance, loadTriggerConfig, prefetchCandidates, trackedReason, queueAction } from "../../src/lib/companies-house/officerTriggers";
import { loadOfficerConfig, OFFICER_PRIORITY } from "../../src/lib/companies-house/officerQueue";
import { restartDelayMs } from "../../src/lib/companies-house/officerWorker";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

test("trackedReason: only turning a marker ON queues; trashing or switching off queues nothing", () => {
  assert.equal(trackedReason({ followed: true }), "followed");
  assert.equal(trackedReason({ saved: true }), "saved");
  assert.equal(trackedReason({ redFlagged: true }), "red_flagged");
  assert.equal(trackedReason({ followed: false }), null);
  assert.equal(trackedReason({ saved: false, redFlagged: false }), null);
  assert.equal(trackedReason({ trashed: true, saved: true }), null);
  assert.equal(trackedReason({}), null);
});

test("allowance: the tightest limit wins and never goes negative", () => {
  assert.equal(allowance(25, { perRequest: 25, userLeft: 100, globalLeft: 2000, depthLeft: 1000 }), 25);
  assert.equal(allowance(25, { userLeft: 10 }), 10);
  assert.equal(allowance(25, { userLeft: 100, globalLeft: 5 }), 5);
  assert.equal(allowance(25, { depthLeft: 3 }), 3);
  assert.equal(allowance(25, { userLeft: -7 }), 0);
  assert.equal(allowance(0, {}), 0);
  assert.equal(allowance(25, {}), 25);
});

test("prefetchCandidates: only real ACTIVE companies without officer data, in display order, capped", () => {
  const rows = [
    { id: "a", status: "active", officersCoverage: "none", source: "bulk_import" },
    { id: "d", status: "dissolved", officersCoverage: "none", source: "advanced_search" },
    { id: "f", status: "active", officersCoverage: "full", source: "bulk_import" },
    { id: "u", status: "active", officersCoverage: "unavailable", source: "bulk_import" },
    { id: "s", status: "active", officersCoverage: "none", source: "seed" },
    { id: "l", status: "liquidation", officersCoverage: "none", source: "bulk_import" },
    { id: "b", status: "active", officersCoverage: "none", source: "stream" },
    { id: "c", status: "active", officersCoverage: "none", source: "bulk_import" },
  ];
  assert.deepEqual(prefetchCandidates(rows, 25), ["a", "b", "c"]);
  assert.deepEqual(prefetchCandidates(rows, 2), ["a", "b"]);
  assert.deepEqual(prefetchCandidates(rows, 0), []);
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, status: "active", officersCoverage: "none", source: "bulk_import" }));
  assert.equal(prefetchCandidates(many, 25).length, 25);
});

test("trigger config: documented defaults, env overrides, invalid values fall back", () => {
  const d = loadTriggerConfig(env({}));
  assert.deepEqual(d, { prefetchPerSearch: 25, prefetchUserDaily: 100, prefetchGlobalDaily: 2000, prefetchQueueCeiling: 1000, trackedUserDaily: 500, reportUserDaily: 5000 });
  const o = loadTriggerConfig(env({ OFFICER_PREFETCH_PER_SEARCH: "10", OFFICER_PREFETCH_USER_DAILY: "0", OFFICER_PREFETCH_GLOBAL_DAILY: "-4", OFFICER_TRACKED_USER_DAILY: "abc" }));
  assert.equal(o.prefetchPerSearch, 10);
  assert.equal(o.prefetchUserDaily, 0);
  assert.equal(o.prefetchGlobalDaily, 2000);
  assert.equal(o.trackedUserDaily, 500);
});

test("daily request cap: default 10,000, override, 0 = unlimited, garbage falls back to the default", () => {
  assert.equal(loadOfficerConfig(env({})).dailyRequestCap, 10_000);
  assert.equal(loadOfficerConfig(env({ OFFICER_DAILY_REQUEST_CAP: "2500" })).dailyRequestCap, 2500);
  assert.equal(loadOfficerConfig(env({ OFFICER_DAILY_REQUEST_CAP: "0" })).dailyRequestCap, 0);
  assert.equal(loadOfficerConfig(env({ OFFICER_DAILY_REQUEST_CAP: "" })).dailyRequestCap, 10_000);
  assert.equal(loadOfficerConfig(env({ OFFICER_DAILY_REQUEST_CAP: "lots" })).dailyRequestCap, 10_000);
  assert.equal(loadOfficerConfig(env({ OFFICER_DAILY_REQUEST_CAP: "-5" })).dailyRequestCap, 10_000);
});

test("priorities and scheduler: prefetch is the lowest queue priority; hitting the daily cap waits an hour", () => {
  assert.ok(OFFICER_PRIORITY.PREFETCH > OFFICER_PRIORITY.REFRESH && OFFICER_PRIORITY.PREFETCH > OFFICER_PRIORITY.FILTER);
  assert.ok(OFFICER_PRIORITY.PREFETCH > OFFICER_PRIORITY.VIEWING && OFFICER_PRIORITY.FOLLOWED < OFFICER_PRIORITY.PREFETCH);
  assert.equal(restartDelayMs("daily_cap"), 60 * 60_000);
  assert.equal(queueAction("prefetch"), "officer_queued_prefetch");
});
