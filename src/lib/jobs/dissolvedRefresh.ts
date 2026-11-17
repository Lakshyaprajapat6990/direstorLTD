import { db } from "@/lib/db";
import { importDissolved, addDays, type DissolvedImportResult } from "@/lib/companies-house/dissolvedImport";

// Scheduled dissolved-company and status refresh (C1). It adds NO new import code: it schedules the existing adaptive, resumable
// importer (dissolvedImport.ts) and keeps its "has this already run" state in the run table, so a scheduler restart can neither
// repeat a finished day nor skip an unfinished one.
//
//   Daily  - companies dissolved since a recent day:  importDissolved({ adaptive, dissolvedSince })
//            (tens of requests; the importer already looks 120 days AHEAD of today for the future cessation dates Companies
//            House stamps on struck-off companies). New dissolved companies are inserted, stored live companies that are now
//            dissolved are reconciled (status + dissolution date only; names, addresses, officers and CRM data are never touched).
//   Weekly - companies in a LIVE non-active status (liquidation, administration, ...): importDissolved({ adaptive, status,
//            reconcileLive }) brings stored companies in line with the register (a company that entered liquidation).
//
// What this CANNOT detect is a company that was dissolved and then RESTORED: it no longer appears in any dissolved list. The
// monthly bulk file (live companies) corrects those where its snapshot is newer than the stored row.
//
// A run counts as done only when it finished "success": a "partial" run (a window that could not be read completely) is retried.

export const DISSOLVED_MARK = "|dissolved>=";
const DAY = 86_400_000;
const OVERLAP_DAYS = 3; // re-read this many already-covered days: a filing can be registered a little after it happened
const MAX_LOOKBACK_DAYS = 120;
const DEFAULT_LOOKBACK_DAYS = 30;

export interface RefreshConfig {
  dissolvedEnabled: boolean;
  hourUtc: number;
  maxAttemptsPerDay: number;
  retryMs: number;
  statusEnabled: boolean;
  statuses: string[];
  statusIntervalDays: number;
}

export function loadRefreshConfig(env: Record<string, string | undefined> = process.env): RefreshConfig {
  const num = (name: string, d: number, min = 0) => (Number.isFinite(Number(env[name])) && env[name]?.trim() !== "" && Number(env[name]) >= min ? Number(env[name]) : d);
  return {
    dissolvedEnabled: env.DISSOLVED_REFRESH_ENABLED === "1",
    hourUtc: Math.min(23, num("DISSOLVED_REFRESH_UTC_HOUR", 4)),
    maxAttemptsPerDay: num("DISSOLVED_REFRESH_MAX_ATTEMPTS", 4),
    retryMs: num("DISSOLVED_REFRESH_RETRY_MINUTES", 60, 1) * 60_000,
    statusEnabled: env.STATUS_RECONCILE_ENABLED === "1",
    statuses: (env.STATUS_RECONCILE_STATUSES ?? "liquidation,administration").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z-]+$/.test(s)),
    statusIntervalDays: num("STATUS_RECONCILE_INTERVAL_DAYS", 7, 1),
  };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const utcMidnight = (d: Date) => new Date(`${isoDay(d)}T00:00:00.000Z`);

// Pure: the first "dissolved on or after" day to ask for. Resumes from the last successful refresh (minus an overlap) so a
// missed week is caught up, capped at the importer's useful range.
export function planDissolvedSince(today: string, lastSuccessDay: string | null): string {
  let since = lastSuccessDay ? addDays(lastSuccessDay, -OVERLAP_DAYS) : addDays(today, -DEFAULT_LOOKBACK_DAYS);
  const floor = addDays(today, -MAX_LOOKBACK_DAYS);
  const ceil = addDays(today, -OVERLAP_DAYS);
  if (since < floor) since = floor;
  if (since > ceil) since = ceil;
  return since;
}

export interface RefreshState {
  doneToday: boolean;
  attemptsToday: number;
  lastAttemptAt: Date | null;
  lastSuccessDay: string | null;
}

// Pure decision (unit tested): is the daily refresh due now?
export function dissolvedRefreshDue(state: RefreshState, now: Date, cfg: Pick<RefreshConfig, "dissolvedEnabled" | "hourUtc" | "maxAttemptsPerDay" | "retryMs">): boolean {
  if (!cfg.dissolvedEnabled || now.getUTCHours() < cfg.hourUtc) return false;
  if (state.doneToday || state.attemptsToday >= cfg.maxAttemptsPerDay) return false;
  if (state.lastAttemptAt && now.getTime() - state.lastAttemptAt.getTime() < cfg.retryMs) return false;
  return true;
}

export async function loadDissolvedRefreshState(now: Date = new Date()): Promise<RefreshState> {
  const dayStart = utcMidnight(now);
  const base = { kind: "advanced_search", inputName: { contains: DISSOLVED_MARK } };
  const [today, lastSuccess] = await Promise.all([
    db.ingestionRun.findMany({ where: { ...base, startedAt: { gte: dayStart } }, select: { status: true, startedAt: true }, orderBy: { startedAt: "desc" } }),
    db.ingestionRun.findFirst({ where: { ...base, status: "success" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
  ]);
  return {
    doneToday: today.some((r) => r.status === "success"),
    attemptsToday: today.length,
    lastAttemptAt: today[0]?.startedAt ?? null,
    lastSuccessDay: lastSuccess ? isoDay(lastSuccess.startedAt) : null,
  };
}

export async function runDissolvedRefresh(options: { now?: Date; signal?: AbortSignal; log?: (m: string) => void } = {}): Promise<DissolvedImportResult> {
  const now = options.now ?? new Date();
  const state = await loadDissolvedRefreshState(now);
  const since = planDissolvedSince(isoDay(now), state.lastSuccessDay);
  options.log?.(`Dissolved refresh: companies dissolved since ${since}`);
  return importDissolved({ adaptive: true, dissolvedSince: since, signal: options.signal, log: options.log });
}

// ---------------------------------------------------------------------------------------------------------------------
// Weekly live-status reconcile
// ---------------------------------------------------------------------------------------------------------------------
export interface StatusState {
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
  failedLast24h: number;
}

export function statusReconcileDue(state: StatusState, now: Date, cfg: Pick<RefreshConfig, "statusEnabled" | "hourUtc" | "maxAttemptsPerDay" | "retryMs" | "statusIntervalDays">): boolean {
  if (!cfg.statusEnabled || now.getUTCHours() < cfg.hourUtc) return false;
  // 1 hour of slack so "every 7 days" does not drift a day later each week.
  if (state.lastSuccessAt && now.getTime() - state.lastSuccessAt.getTime() < cfg.statusIntervalDays * DAY - 3_600_000) return false;
  if (state.failedLast24h >= cfg.maxAttemptsPerDay) return false;
  if (state.lastAttemptAt && now.getTime() - state.lastAttemptAt.getTime() < cfg.retryMs) return false;
  return true;
}

export async function loadStatusReconcileState(status: string, now: Date = new Date()): Promise<StatusState> {
  // The importer names these runs "<status>:<from>..<to>|adaptive" (no dissolved>= part).
  const where = { kind: "advanced_search", inputName: { startsWith: `${status}:`, contains: "|adaptive", not: { contains: DISSOLVED_MARK } } };
  const [lastSuccess, lastAttempt, failed] = await Promise.all([
    db.ingestionRun.findFirst({ where: { ...where, status: "success" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    db.ingestionRun.findFirst({ where, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    db.ingestionRun.count({ where: { ...where, status: { in: ["failed", "partial"] }, startedAt: { gte: new Date(now.getTime() - DAY) } } }),
  ]);
  return { lastSuccessAt: lastSuccess?.startedAt ?? null, lastAttemptAt: lastAttempt?.startedAt ?? null, failedLast24h: failed };
}

export async function runStatusReconcile(status: string, options: { signal?: AbortSignal; log?: (m: string) => void } = {}): Promise<DissolvedImportResult> {
  options.log?.(`Status reconcile: companies currently "${status}"`);
  return importDissolved({ adaptive: true, status, reconcileLive: true, signal: options.signal, log: options.log });
}
