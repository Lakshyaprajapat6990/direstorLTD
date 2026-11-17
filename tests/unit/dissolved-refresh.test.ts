import { test } from "node:test";
import assert from "node:assert/strict";
import { dissolvedRefreshDue, loadRefreshConfig, planDissolvedSince, statusReconcileDue, type RefreshConfig, type RefreshState } from "../../src/lib/jobs/dissolvedRefresh";

const cfg: RefreshConfig = { dissolvedEnabled: true, hourUtc: 4, maxAttemptsPerDay: 4, retryMs: 3_600_000, statusEnabled: true, statuses: ["liquidation"], statusIntervalDays: 7 };
const at = (iso: string) => new Date(iso);
const state = (over: Partial<RefreshState> = {}): RefreshState => ({ doneToday: false, attemptsToday: 0, lastAttemptAt: null, lastSuccessDay: null, ...over });

test("planDissolvedSince: first ever run looks back 30 days", () => {
  assert.equal(planDissolvedSince("2026-11-14", null), "2026-10-15");
});

test("planDissolvedSince: resumes from the last success with a 3-day overlap, so a missed week is caught up", () => {
  assert.equal(planDissolvedSince("2026-11-14", "2026-11-13"), "2026-11-10");
  assert.equal(planDissolvedSince("2026-11-14", "2026-11-05"), "2026-11-02");
});

test("planDissolvedSince: capped at 120 days back and never later than today minus the overlap", () => {
  assert.equal(planDissolvedSince("2026-11-14", "2025-01-01"), "2026-07-17");
  assert.equal(planDissolvedSince("2026-11-14", "2026-11-14"), "2026-11-11");
});

test("dissolved refresh is due after the hour, once per UTC day", () => {
  assert.equal(dissolvedRefreshDue(state(), at("2026-11-14T03:59:00Z"), cfg), false); // too early
  assert.equal(dissolvedRefreshDue(state(), at("2026-11-14T04:00:00Z"), cfg), true);
  assert.equal(dissolvedRefreshDue(state({ doneToday: true }), at("2026-11-14T09:00:00Z"), cfg), false);
});

test("a failed attempt is retried after the retry delay, up to the daily maximum", () => {
  const failed = state({ attemptsToday: 1, lastAttemptAt: at("2026-11-14T04:00:00Z") });
  assert.equal(dissolvedRefreshDue(failed, at("2026-11-14T04:30:00Z"), cfg), false); // too soon
  assert.equal(dissolvedRefreshDue(failed, at("2026-11-14T05:01:00Z"), cfg), true);
  assert.equal(dissolvedRefreshDue(state({ attemptsToday: 4, lastAttemptAt: at("2026-11-14T08:00:00Z") }), at("2026-11-14T23:00:00Z"), cfg), false);
});

test("a disabled refresh never runs", () => {
  assert.equal(dissolvedRefreshDue(state(), at("2026-11-14T12:00:00Z"), { ...cfg, dissolvedEnabled: false }), false);
});

test("status reconcile runs weekly, not daily, and is retried after a failure", () => {
  const ok = { lastSuccessAt: at("2026-11-07T04:10:00Z"), lastAttemptAt: at("2026-11-07T04:10:00Z"), failedLast24h: 0 };
  assert.equal(statusReconcileDue(ok, at("2026-11-13T05:00:00Z"), cfg), false); // 6 days
  assert.equal(statusReconcileDue(ok, at("2026-11-14T05:00:00Z"), cfg), true); // 7 days (with an hour of slack)
  assert.equal(statusReconcileDue({ lastSuccessAt: null, lastAttemptAt: null, failedLast24h: 0 }, at("2026-11-14T05:00:00Z"), cfg), true); // never run
  assert.equal(statusReconcileDue({ lastSuccessAt: null, lastAttemptAt: at("2026-11-14T04:30:00Z"), failedLast24h: 1 }, at("2026-11-14T05:00:00Z"), cfg), false); // retry delay
  assert.equal(statusReconcileDue({ lastSuccessAt: null, lastAttemptAt: at("2026-11-14T01:00:00Z"), failedLast24h: 4 }, at("2026-11-14T05:00:00Z"), cfg), false); // gave up for today
});

test("loadRefreshConfig: everything is off unless explicitly enabled; bad status names are dropped", () => {
  const off = loadRefreshConfig({});
  assert.equal(off.dissolvedEnabled, false);
  assert.equal(off.statusEnabled, false);
  assert.deepEqual(off.statuses, ["liquidation", "administration"]);
  const on = loadRefreshConfig({ DISSOLVED_REFRESH_ENABLED: "1", STATUS_RECONCILE_ENABLED: "1", STATUS_RECONCILE_STATUSES: "Liquidation, bad;status ,receivership", DISSOLVED_REFRESH_UTC_HOUR: "5" });
  assert.equal(on.dissolvedEnabled, true);
  assert.deepEqual(on.statuses, ["liquidation", "receivership"]);
  assert.equal(on.hourUtc, 5);
});

test("the local supervisor scripts: the registrations scheduler enables the daily dissolved REGISTER refresh, the officer scheduler leaves it off", async () => {
  const { readFileSync } = await import("node:fs");
  const envOf = (file: string) => { const env: Record<string, string> = {}; for (const l of readFileSync(file, "utf8").split(/\r?\n/)) { const m = /^\$env:([A-Z_]+) = "([^"]*)"/.exec(l); if (m) env[m[1]] = m[2]; } return env; };
  const reg = loadRefreshConfig(envOf("scripts/run-registrations-scheduler.ps1"));
  assert.equal(reg.dissolvedEnabled, true);
  assert.equal(reg.hourUtc, 4);
  assert.equal(loadRefreshConfig(envOf("scripts/run-officer-scheduler.ps1")).dissolvedEnabled, false);
});
