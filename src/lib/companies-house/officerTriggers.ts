import { db } from "@/lib/db";
import { buildCompanyWhere } from "@/lib/data/companies";
import { hasActiveDirectorRules } from "@/lib/filters/compile";
import { can, resolvePermissions, type HasPermissions } from "@/lib/auth/permissions";
import type { UserRole } from "@/lib/types";
import { makeLogger } from "@/lib/log";
import { enqueueOfficerJobs, loadOfficerConfig, OFFICER_PRIORITY, type EnqueueResult } from "./officerQueue";

// When does officer data get fetched without anyone asking for it explicitly? Only through the entry points below. They all
// do the same thing: put eligible companies (real, no officer data yet) on the officer queue. They never call Companies
// House themselves - the officer worker does that, inside the shared quota gate - and they never fail the user's action.
//
//   queueTrackedCompanies   a person follows / saves / red-flags a company      priority 2 (FOLLOWED)
//   enqueueReportOfficers   a report is created, refreshed or daily-refreshed   priority 1 (REPORT)
//   prefetchSearchResults   a search page is shown: its first 25 ACTIVE companies priority 5 (PREFETCH, lowest)
//
// Viewing a company page stays an inline fetch (priority 0, the interactive quota class); it is not queued here.
// Budgets: every user-initiated queueing is counted per person and per UTC day in the activity log (no new table), and the
// prefetch also has a global daily ceiling and a ceiling on how many prefetch jobs may wait. Dissolved companies are never
// prefetched; they are queued only when a person follows / saves / red-flags them or a report includes them.

const log = makeLogger("officer-triggers");

export type QueueKind = "tracked" | "report" | "prefetch";
// One activity-log action per kind. Their meta is always our own small JSON ({"queued": n}), and the budget query only casts
// rows that were already filtered by action, so unrelated (possibly truncated) activity rows are never parsed.
export const queueAction = (kind: QueueKind) => `officer_queued_${kind}`;

export interface TriggerConfig {
  prefetchPerSearch: number; // companies one search page may queue
  prefetchUserDaily: number; // companies one person's searches may queue per UTC day
  prefetchGlobalDaily: number; // companies all searches together may queue per UTC day
  prefetchQueueCeiling: number; // prefetch jobs allowed to be waiting at once
  trackedUserDaily: number; // follow / save / red-flag queueing per person per UTC day
  reportUserDaily: number; // report queueing per person per UTC day
}

export function loadTriggerConfig(env: NodeJS.ProcessEnv = process.env): TriggerConfig {
  const n = (name: string, d: number) => {
    const raw = env[name]?.trim();
    return raw && Number.isInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : d;
  };
  return {
    prefetchPerSearch: n("OFFICER_PREFETCH_PER_SEARCH", 25),
    prefetchUserDaily: n("OFFICER_PREFETCH_USER_DAILY", 100),
    prefetchGlobalDaily: n("OFFICER_PREFETCH_GLOBAL_DAILY", 2000),
    prefetchQueueCeiling: n("OFFICER_PREFETCH_QUEUE_CEILING", 1000),
    trackedUserDaily: n("OFFICER_TRACKED_USER_DAILY", 500),
    reportUserDaily: n("OFFICER_REPORT_USER_DAILY", 5000),
  };
}

// Pure: how many of `wanted` may be queued given what is left of each budget (undefined = no limit on that axis).
export function allowance(wanted: number, limits: { perRequest?: number; userLeft?: number; globalLeft?: number; depthLeft?: number }): number {
  const parts = [wanted, limits.perRequest, limits.userLeft, limits.globalLeft, limits.depthLeft].filter((x): x is number => x !== undefined);
  return Math.max(0, Math.floor(Math.min(...parts)));
}

export interface TriggerActor extends HasPermissions {
  userId: string;
  sid?: string;
}

const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

// Companies queued today (UTC) for `kind`, by one person and by everyone.
export async function queuedToday(kind: QueueKind, userId: string, now: Date = new Date()): Promise<{ user: number; all: number }> {
  const rows = await db.$queryRaw<{ mine: number | null; total: number | null }[]>`
    SELECT COALESCE(SUM((meta::jsonb->>'queued')::int) FILTER (WHERE "userId" = ${userId}), 0)::int AS mine,
           COALESCE(SUM((meta::jsonb->>'queued')::int), 0)::int AS total
    FROM "ActivityLog"
    WHERE action = ${queueAction(kind)} AND "createdAt" >= CAST(${utcDayStart(now).toISOString()} AS timestamp)`;
  return { user: rows[0]?.mine ?? 0, all: rows[0]?.total ?? 0 };
}

async function recordQueued(actor: TriggerActor, kind: QueueKind, queued: number, extra: Record<string, unknown> = {}) {
  if (queued <= 0) return;
  await db.activityLog.create({ data: { userId: actor.userId, action: queueAction(kind), meta: JSON.stringify({ queued, ...extra }), sessionId: actor.sid ?? null } });
}

const canSeeDirectors = (s: HasPermissions) => can(s, "companies.directors");

// ---- follow / save / red-flag ------------------------------------------------------------------------------------
// Which marker, if any, the (resolved) state patch switches ON. Turning a marker off, or trashing, queues nothing.
export function trackedReason(patch: { followed?: boolean; saved?: boolean; redFlagged?: boolean; trashed?: boolean }): "followed" | "saved" | "red_flagged" | null {
  if (patch.trashed === true) return null;
  if (patch.followed === true) return "followed";
  if (patch.saved === true) return "saved";
  if (patch.redFlagged === true) return "red_flagged";
  return null;
}

export async function queueTrackedCompanies(
  actor: TriggerActor,
  companyIds: string[],
  patch: { followed?: boolean; saved?: boolean; redFlagged?: boolean; trashed?: boolean }
): Promise<EnqueueResult | null> {
  try {
    const reason = trackedReason(patch);
    if (!reason || companyIds.length === 0 || !canSeeDirectors(actor)) return null;
    const cfg = loadTriggerConfig();
    const used = await queuedToday("tracked", actor.userId);
    const n = allowance(companyIds.length, { userLeft: cfg.trackedUserDaily - used.user });
    if (n === 0) return null;
    const res = await enqueueOfficerJobs(companyIds.slice(0, n), { priority: OFFICER_PRIORITY.FOLLOWED, reason });
    await recordQueued(actor, "tracked", res.inserted, { reason });
    return res;
  } catch (err) {
    log.error("tracked queueing failed", { err: err instanceof Error ? err.message : String(err) });
    return null; // the state change itself has already succeeded
  }
}

// ---- reports -------------------------------------------------------------------------------------------------------
// May this report owner see director data at all? (A report's companies are only queued for people who could read the result.)
export async function ownerCanSeeDirectors(ownerId: string): Promise<boolean> {
  const u = await db.user.findUnique({ where: { id: ownerId }, select: { role: true, permissions: true, active: true } });
  if (!u || !u.active) return false;
  return can({ role: u.role as UserRole, permissions: resolvePermissions(u.role as UserRole, u.permissions) }, "companies.directors");
}

// Queues the companies a report matches that have no officer data yet: active companies first, then the rest, up to `cap`
// (default OFFICER_ENQUEUE_CAP). Dissolved companies are only queued here because the report itself includes them.
export async function enqueueReportOfficers(
  report: { filterJson: string; ownerId: string },
  options: { cap?: number; actor?: TriggerActor; ownerChecked?: boolean } = {}
): Promise<{ queued: number; upgraded: number; skipped: string | null }> {
  const none = (skipped: string) => ({ queued: 0, upgraded: 0, skipped });
  try {
    if (!options.ownerChecked && !(await ownerCanSeeDirectors(report.ownerId))) return none("no_director_permission");
    const cfg = loadTriggerConfig();
    let cap = options.cap ?? loadOfficerConfig().enqueueCap;
    if (options.actor) {
      const used = await queuedToday("report", options.actor.userId);
      cap = allowance(cap, { userLeft: cfg.reportUserDaily - used.user });
      if (cap === 0) return none("daily_limit");
    }
    const filter = JSON.parse(report.filterJson);
    const where = buildCompanyWhere({ filter, mode: hasActiveDirectorRules(filter) ? "possible" : "confirmed", userId: report.ownerId });
    const base = { AND: [where, { officersCoverage: "none" }] };
    const active = await db.company.findMany({ where: { AND: [base, { status: "active" }] }, select: { id: true }, orderBy: { id: "asc" }, take: cap + 1 });
    let ids = active.map((c) => c.id);
    if (ids.length < cap) {
      const rest = await db.company.findMany({ where: { AND: [base, { status: { not: "active" } }] }, select: { id: true }, orderBy: { id: "asc" }, take: cap - ids.length + 1 });
      ids = ids.concat(rest.map((c) => c.id));
    }
    const res = await enqueueOfficerJobs(ids, { priority: OFFICER_PRIORITY.REPORT, reason: "report", cap });
    if (options.actor) await recordQueued(options.actor, "report", res.inserted);
    return { queued: res.inserted, upgraded: res.upgraded, skipped: null };
  } catch (err) {
    log.error("report queueing failed", { err: err instanceof Error ? err.message : String(err) });
    return none("error");
  }
}

// ---- company page fallback ---------------------------------------------------------------------------------------
// The company page fetches officers inline. When that fails (Companies House unavailable or rate-limited) the company is queued
// so the worker completes it, instead of the data waiting for the next view. Idempotent; never throws.
export async function queueFailedView(companyId: string): Promise<EnqueueResult | null> {
  try {
    return await enqueueOfficerJobs([companyId], { priority: OFFICER_PRIORITY.FOLLOWED, reason: "view_retry", cap: 1 });
  } catch (err) {
    log.error("view retry queueing failed", { err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

// ---- search-result prefetch --------------------------------------------------------------------------------------
export interface PrefetchRow {
  id: string;
  status: string;
  officersCoverage: string;
  source: string;
}

// Pure: the companies of one search page that are worth prefetching, in display order: active, no officer data yet, real.
export function prefetchCandidates(rows: PrefetchRow[], limit: number): string[] {
  return rows.filter((r) => r.status === "active" && r.officersCoverage === "none" && r.source !== "seed").slice(0, Math.max(0, limit)).map((r) => r.id);
}

export async function prefetchSearchResults(actor: TriggerActor & { role: string }, rows: PrefetchRow[]): Promise<{ queued: number; reason: string }> {
  try {
    const cfg = loadTriggerConfig();
    if (cfg.prefetchPerSearch === 0) return { queued: 0, reason: "disabled" };
    // Free customers may not spend shared quota on speculation; their own page views still fetch inline.
    if (actor.role === "CUSTOMER") return { queued: 0, reason: "customer" };
    if (!canSeeDirectors(actor)) return { queued: 0, reason: "no_director_permission" };
    const ids = prefetchCandidates(rows, cfg.prefetchPerSearch);
    if (ids.length === 0) return { queued: 0, reason: "nothing_to_fetch" };

    const used = await queuedToday("prefetch", actor.userId);
    const waiting = await db.officerSyncJob.count({ where: { reason: "search_prefetch", status: { in: ["queued", "retry"] } } });
    const n = allowance(ids.length, {
      userLeft: cfg.prefetchUserDaily - used.user,
      globalLeft: cfg.prefetchGlobalDaily - used.all,
      depthLeft: cfg.prefetchQueueCeiling - waiting,
    });
    if (n === 0) return { queued: 0, reason: "budget" };
    const res = await enqueueOfficerJobs(ids.slice(0, n), { priority: OFFICER_PRIORITY.PREFETCH, reason: "search_prefetch", cap: n });
    await recordQueued(actor, "prefetch", res.inserted);
    return { queued: res.inserted, reason: "ok" };
  } catch (err) {
    log.error("prefetch failed", { err: err instanceof Error ? err.message : String(err) });
    return { queued: 0, reason: "error" };
  }
}
