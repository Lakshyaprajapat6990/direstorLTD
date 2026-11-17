import type { IngestionRun } from "@prisma/client";
import { db } from "@/lib/db";
import { SCHEDULER_STALE_AFTER_MS, finishRun, reconcileStaleRuns, touchRun } from "./runs";

// Scheduler heartbeat + cross-instance protection (C8).
//
// Every scheduler process owns one IngestionRun row of kind "scheduler" for as long as it lives:
//   - inputName = the instance id (host:pid), statsJson.jobs = the jobs this instance is responsible for;
//   - the row is heartbeated every ~30 seconds, and reconciled to "failed" after SCHEDULER_STALE_AFTER_MS (two minutes) of
//     silence, so a crashed process stops blocking its replacement almost at once;
//   - a graceful shutdown finishes the row ("success"), freeing the jobs immediately.
//
// Protection is per JOB, not per process, because the existing local setup deliberately runs two schedulers on one database
// with disjoint job sets (new registrations in one, the officer worker in the other). A starting scheduler is refused only if a
// live scheduler already owns one of the jobs it wants. The check and the insert run under a PostgreSQL advisory lock, so two
// schedulers starting at the same instant cannot both pass. This is in addition to the per-job single-flight locks in runs.ts
// (which cannot protect the filing stream: Companies House allows a single connection per key).
//
// No migration: IngestionRun already carries everything needed.

export const SCHEDULER_HEARTBEAT_MS = 30_000;

export const SCHEDULER_JOBS = ["new_registrations", "daily_update", "dissolved_refresh", "status_reconcile", "monthly_bulk", "officer_worker", "stream"] as const;
export type SchedulerJob = (typeof SCHEDULER_JOBS)[number];

export class SchedulerAlreadyRunningError extends Error {
  constructor(public conflicts: { id: string; instance: string; jobs: string[] }[], public overlapping: string[]) {
    super(
      `Another scheduler is already running the same job(s) on this database: ${overlapping.join(", ")} ` +
        `(held by ${conflicts.map((c) => c.instance).join(", ")}). Only one scheduler may own a job at a time.`
    );
  }
}

export function parseSchedulerJobs(statsJson: string | null | undefined): string[] {
  if (!statsJson) return [];
  try {
    const jobs = (JSON.parse(statsJson) as { jobs?: unknown }).jobs;
    return Array.isArray(jobs) ? jobs.filter((j): j is string => typeof j === "string") : [];
  } catch {
    return [];
  }
}

export const overlap = (a: string[], b: string[]) => a.filter((j) => b.includes(j));

export async function acquireSchedulerLease(instance: string, jobs: string[], meta: Record<string, unknown> = {}): Promise<IngestionRun> {
  await reconcileStaleRuns();
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"scheduler_lease"}))`;
      const live = await tx.ingestionRun.findMany({ where: { kind: "scheduler", status: "running" } });
      const conflicts = live
        .map((r) => ({ id: r.id, instance: r.inputName ?? r.id, jobs: parseSchedulerJobs(r.statsJson) }))
        .filter((r) => overlap(r.jobs, jobs).length > 0);
      if (conflicts.length) {
        throw new SchedulerAlreadyRunningError(conflicts, [...new Set(conflicts.flatMap((c) => overlap(c.jobs, jobs)))]);
      }
      return tx.ingestionRun.create({ data: { kind: "scheduler", status: "running", inputName: instance, statsJson: JSON.stringify({ ...meta, jobs }) } });
    },
    { timeout: 15_000 }
  );
}

export type HeartbeatResult = { ok: true } | { ok: false; reason: string };

// Called on a timer. Refreshes the heartbeat, then makes sure this instance still owns its jobs: if the process was paused long
// enough (laptop sleep, a stalled VM) for the row to be reconciled AND a newer scheduler took over the same jobs, the OLDER one
// must stand down - it returns ok:false and the caller shuts down.
export async function heartbeatSchedulerLease(id: string, jobs: string[]): Promise<HeartbeatResult> {
  await touchRun(id);
  const me = await db.ingestionRun.findUnique({ where: { id }, select: { status: true, startedAt: true } });
  if (!me || me.status !== "running") return { ok: false, reason: "scheduler row is no longer running" };
  const newer = await db.ingestionRun.findMany({ where: { kind: "scheduler", status: "running", id: { not: id }, startedAt: { gt: me.startedAt } } });
  const taken = newer.flatMap((r) => overlap(parseSchedulerJobs(r.statsJson), jobs));
  if (taken.length) return { ok: false, reason: `a newer scheduler has taken over: ${[...new Set(taken)].join(", ")}` };
  return { ok: true };
}

export async function releaseSchedulerLease(id: string, reason: string, jobs: string[], status: "success" | "failed" = "success"): Promise<void> {
  const row = await db.ingestionRun.findUnique({ where: { id }, select: { statsJson: true } });
  let base: Record<string, unknown> = {};
  try {
    base = row?.statsJson ? (JSON.parse(row.statsJson) as Record<string, unknown>) : {};
  } catch {
    /* unreadable: replace */
  }
  await finishRun(id, status, { statsJson: JSON.stringify({ ...base, jobs, stoppedReason: reason }), errorMessage: status === "failed" ? reason : null });
}

export interface SchedulerStatus {
  // At least one scheduler process has a fresh heartbeat.
  alive: boolean;
  // Union of the jobs of every live scheduler (or, when none is alive, of the most recent ones: what SHOULD be running).
  jobs: string[];
  lastHeartbeatAt: Date | null;
  instances: { instance: string; jobs: string[]; startedAt: Date; heartbeatAt: Date; alive: boolean }[];
  // True when a scheduler has never recorded a heartbeat on this database.
  neverSeen: boolean;
}

export async function loadSchedulerStatus(now: Date = new Date()): Promise<SchedulerStatus> {
  const rows = await db.ingestionRun.findMany({ where: { kind: "scheduler" }, orderBy: { startedAt: "desc" }, take: 20 });
  if (rows.length === 0) return { alive: false, jobs: [], lastHeartbeatAt: null, instances: [], neverSeen: true };
  const isAlive = (r: IngestionRun) => r.status === "running" && now.getTime() - r.heartbeatAt.getTime() <= SCHEDULER_STALE_AFTER_MS * 2.5;
  const alive = rows.filter(isAlive);
  // What should be running when nothing is: the jobs of the scheduler(s) seen most recently (within a week).
  const recent = rows.filter((r) => now.getTime() - r.startedAt.getTime() < 7 * 86_400_000);
  const basis = alive.length ? alive : recent;
  return {
    alive: alive.length > 0,
    jobs: [...new Set(basis.flatMap((r) => parseSchedulerJobs(r.statsJson)))],
    lastHeartbeatAt: rows.reduce<Date | null>((m, r) => (!m || r.heartbeatAt > m ? r.heartbeatAt : m), null),
    instances: alive.map((r) => ({ instance: r.inputName ?? r.id, jobs: parseSchedulerJobs(r.statsJson), startedAt: r.startedAt, heartbeatAt: r.heartbeatAt, alive: true })),
    neverSeen: false,
  };
}
