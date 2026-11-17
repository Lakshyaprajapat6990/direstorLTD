import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateHealth, type HealthInput } from "../../src/lib/jobs/health";
import type { SchedulerStatus } from "../../src/lib/jobs/schedulerLease";

const now = new Date("2026-11-14T12:00:00Z");
const h = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000);
const src = (lastSuccessAt: Date | null) => ({ lastSuccessAt, latestRun: null });
const alive = (jobs: string[], startedHoursAgo = 100): SchedulerStatus => ({
  alive: true,
  jobs,
  lastHeartbeatAt: new Date(now.getTime() - 20_000),
  neverSeen: false,
  instances: [{ instance: "srv:1", jobs, startedAt: h(startedHoursAgo), heartbeatAt: new Date(now.getTime() - 20_000), alive: true }],
});
type Over = Partial<Omit<HealthInput, "freshness">> & { scheduler?: SchedulerStatus; dissolved?: Date | null; daily?: Date | null; covered?: string | null };
const base = (over: Over = {}): HealthInput => ({
  now,
  freshness: {
    registrations: { ...src(h(2)), coveredThrough: over.covered === undefined ? "2026-11-14" : over.covered },
    dissolved: src(over.dissolved === undefined ? h(8) : over.dissolved),
    daily: src(over.daily === undefined ? h(9) : over.daily),
    scheduler: over.scheduler ?? alive(["new_registrations", "daily_update", "dissolved_refresh", "officer_worker"]),
  },
  schedulerExpected: over.schedulerExpected ?? true,
  restConfigured: over.restConfigured ?? true,
  stalledJobs: over.stalledJobs ?? 0,
  pendingDs01Events: over.pendingDs01Events ?? 0,
  stream: over.stream ?? { configured: false, status: "never", lastEventAgeSeconds: null },
});

test("everything fresh and the scheduler alive is ok", () => {
  assert.deepEqual(evaluateHealth(base()), { degraded: false, reasons: [] });
});

test("an expected scheduler that never started is reported", () => {
  const neverSeen: SchedulerStatus = { alive: false, jobs: [], lastHeartbeatAt: null, instances: [], neverSeen: true };
  assert.deepEqual(evaluateHealth(base({ scheduler: neverSeen })).reasons, ["scheduler_never_started"]);
  assert.equal(evaluateHealth(base({ scheduler: neverSeen, schedulerExpected: false })).degraded, false); // legacy sites are not alarmed
});

test("a scheduler that stopped heartbeating is reported down", () => {
  const dead: SchedulerStatus = { ...alive(["new_registrations"]), alive: false, instances: [], lastHeartbeatAt: new Date(now.getTime() - 3_600_000) };
  assert.ok(evaluateHealth(base({ scheduler: dead })).reasons.includes("scheduler_down"));
});

test("registrations more than 3 days behind are reported", () => {
  assert.ok(evaluateHealth(base({ covered: "2026-11-10" })).reasons.includes("registrations_stale"));
  assert.ok(!evaluateHealth(base({ covered: "2026-11-12" })).reasons.includes("registrations_stale"));
});

test("an owned dissolved refresh that has not succeeded for over 36 h is reported; one not owned is ignored", () => {
  assert.ok(evaluateHealth(base({ dissolved: h(40) })).reasons.includes("dissolved_refresh_overdue"));
  assert.ok(!evaluateHealth(base({ dissolved: h(40), scheduler: alive(["new_registrations"]) })).reasons.includes("dissolved_refresh_overdue"));
});

test("a never-succeeded job only alarms after the scheduler has been alive for 36 h", () => {
  assert.ok(!evaluateHealth(base({ dissolved: null, scheduler: alive(["dissolved_refresh"], 5) })).reasons.includes("dissolved_refresh_overdue"));
  assert.ok(evaluateHealth(base({ dissolved: null, scheduler: alive(["dissolved_refresh"], 50) })).reasons.includes("dissolved_refresh_overdue"));
});

test("stalled jobs, pending DS01 events and a silent stream are reported", () => {
  const r = evaluateHealth(base({ stalledJobs: 1, pendingDs01Events: 2, stream: { configured: true, status: "running", lastEventAgeSeconds: 3600 } })).reasons;
  assert.deepEqual([...r].sort(), ["pending_ds01_events", "stalled_jobs", "stream_silent"]);
});
