import type { IngestionFreshness } from "@/lib/data/freshness";
import { DAILY_UPDATE_STALE_AFTER_MS } from "./display";

// Health verdict for /api/health. Pure, so it is unit tested without a database or a server.
//
// "degraded" means the site is serving but ingestion needs attention. What is EXPECTED to be running is learned from the
// scheduler's own heartbeat row (it records the jobs it owns), so the website needs no copy of the scheduler's configuration.

export const REGISTRATIONS_STALE_DAYS = 3;
export const SCHEDULER_STALE_ALERT_MS = 5 * 60_000;
export const DISSOLVED_STALE_AFTER_MS = DAILY_UPDATE_STALE_AFTER_MS; // 36 hours: due once a day, retried for a few hours

export interface HealthInput {
  now: Date;
  freshness: Pick<IngestionFreshness, "registrations" | "dissolved" | "daily" | "scheduler">;
  // SCHEDULER_EXPECTED=1 on the website: "a scheduler MUST be running for this database" (so a scheduler that never started is reported).
  schedulerExpected: boolean;
  restConfigured: boolean;
  stalledJobs: number;
  pendingDs01Events: number;
  stream: { configured: boolean; status: string; lastEventAgeSeconds: number | null };
}

export interface HealthVerdict {
  degraded: boolean;
  reasons: string[];
}

export function evaluateHealth(input: HealthInput): HealthVerdict {
  const { now, freshness, stream } = input;
  const reasons: string[] = [];
  const sched = freshness.scheduler;
  const expectedJobs = sched.jobs;
  const schedulerSince = sched.instances.reduce<Date | null>((m, i) => (!m || i.startedAt < m ? i.startedAt : m), null);
  const age = (d: Date | null) => (d ? now.getTime() - d.getTime() : null);

  if (input.stalledJobs > 0) reasons.push("stalled_jobs");
  if (input.pendingDs01Events > 0) reasons.push("pending_ds01_events");
  if (stream.configured && stream.status !== "running") reasons.push("stream_not_running");
  if (stream.configured && stream.lastEventAgeSeconds !== null && stream.lastEventAgeSeconds > 15 * 60) reasons.push("stream_silent");

  // Scheduler availability.
  if (sched.neverSeen) {
    if (input.schedulerExpected) reasons.push("scheduler_never_started");
  } else if (!sched.alive || (age(sched.lastHeartbeatAt) ?? 0) > SCHEDULER_STALE_ALERT_MS) {
    reasons.push("scheduler_down");
  }

  // Registrations: more than 3 days behind means that job is failing or not running. (Also checked when only the website knows a
  // Companies House key exists, as before.)
  const reg = freshness.registrations.coveredThrough;
  const lagDays = reg ? Math.floor((now.getTime() - Date.parse(reg + "T00:00:00Z")) / 86_400_000) : null;
  if ((input.restConfigured || expectedJobs.includes("new_registrations")) && lagDays !== null && lagDays > REGISTRATIONS_STALE_DAYS) reasons.push("registrations_stale");

  // Daily jobs the live scheduler owns must have succeeded recently. With no success on record, give a scheduler 36 hours of life first.
  const overdue = (last: Date | null) => {
    const a = age(last);
    if (a !== null) return a > DISSOLVED_STALE_AFTER_MS;
    const since = age(schedulerSince);
    return since !== null && since > DISSOLVED_STALE_AFTER_MS;
  };
  if (sched.alive && expectedJobs.includes("dissolved_refresh") && overdue(freshness.dissolved.lastSuccessAt)) reasons.push("dissolved_refresh_overdue");
  if (sched.alive && expectedJobs.includes("daily_update") && overdue(freshness.daily.lastSuccessAt)) reasons.push("daily_update_overdue");

  return { degraded: reasons.length > 0, reasons };
}
