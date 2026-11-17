import { db } from "@/lib/db";
import { DISSOLVED_MARK } from "@/lib/jobs/dissolvedRefresh";
import { loadSchedulerStatus, type SchedulerStatus } from "@/lib/jobs/schedulerLease";

// "When was the company data last brought up to date from Companies House?"
//
// This is the finish time of the newest successful (or partial) company-data sync: the monthly bulk file or the
// new-registrations sync. It deliberately does NOT use the filing stream's last event or the daily recompute: those
// show that a job is alive, not that new registrations and changed details have been loaded (the stream alone only
// ever carried strike-off filings). If no such sync has ever run it falls back to the older stream / daily timestamps so
// a fresh install does not show an empty value.
export interface DataFreshness {
  lastUpdated: Date | null;
  // Last incorporation day the new-registrations sync has fully stored (YYYY-MM-DD).
  registrationsThrough: string | null;
  // As-of date of the newest monthly bulk file that was loaded (YYYY-MM-DD).
  bulkSnapshot: string | null;
}

export async function getDataFreshness(): Promise<DataFreshness> {
  const ok = { in: ["success", "partial"] };
  const [bulk, bulkSuccess, reg, regCovered, checkpoint, daily] = await Promise.all([
    // The loaded snapshot date counts any run that stored data (success or partial); the TIMESTAMP needs a clean success.
    db.ingestionRun.findFirst({ where: { kind: "bulk_csv", status: ok }, orderBy: { startedAt: "desc" }, select: { finishedAt: true, statsJson: true } }),
    db.ingestionRun.findFirst({ where: { kind: "bulk_csv", status: "success" }, orderBy: { startedAt: "desc" }, select: { finishedAt: true } }),
    db.ingestionRun.findFirst({ where: { kind: "new_registrations", status: "success" }, orderBy: { startedAt: "desc" }, select: { finishedAt: true } }),
    db.ingestionRun.findFirst({ where: { kind: "new_registrations", checkpoint: { not: null, lte: new Date().toISOString().slice(0, 10) } }, orderBy: { checkpoint: "desc" }, select: { checkpoint: true } }),
    db.streamCheckpoint.findUnique({ where: { name: "filings" }, select: { lastEventAt: true } }),
    db.ingestionRun.findFirst({ where: { kind: "daily_update", status: ok }, orderBy: { startedAt: "desc" }, select: { finishedAt: true } }),
  ]);

  let bulkSnapshot: string | null = null;
  try {
    bulkSnapshot = bulk?.statsJson ? ((JSON.parse(bulk.statsJson) as { snapshotDate?: string | null }).snapshotDate ?? null) : null;
  } catch {
    /* unreadable stats: unknown */
  }

  const synced = [bulkSuccess?.finishedAt, reg?.finishedAt].filter((d): d is Date => !!d);
  const candidates = synced.length ? synced : [checkpoint?.lastEventAt, daily?.finishedAt].filter((d): d is Date => !!d);
  const lastUpdated = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null;
  return { lastUpdated, registrationsThrough: regCovered?.checkpoint ?? null, bulkSnapshot };
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-source freshness for monitoring (Super Admin, /api/health, `npm run jobs:status`). Every "lastSuccessAt" is the finish time
// of the newest run that ended "success"; the latest run is reported separately so a failure is visible next to the old success.
// ---------------------------------------------------------------------------------------------------------------------
export interface RunSummary {
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}
export interface SourceFreshness {
  lastSuccessAt: Date | null;
  latestRun: RunSummary | null;
}
export interface IngestionFreshness {
  registrations: SourceFreshness & { coveredThrough: string | null };
  dissolved: SourceFreshness;
  statusReconcile: SourceFreshness;
  bulk: SourceFreshness & { snapshot: string | null };
  daily: SourceFreshness;
  officers: SourceFreshness & { lastActivityAt: Date | null };
  scheduler: SchedulerStatus;
}

const summarise = (r: { status: string; startedAt: Date; finishedAt: Date | null; errorMessage: string | null } | null): RunSummary | null =>
  r ? { status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, error: r.errorMessage?.slice(0, 300) ?? null } : null;

export async function getIngestionFreshness(): Promise<IngestionFreshness> {
  const pair = async (where: object): Promise<SourceFreshness> => {
    const [success, latest] = await Promise.all([
      db.ingestionRun.findFirst({ where: { ...where, status: "success" }, orderBy: { startedAt: "desc" }, select: { finishedAt: true } }),
      db.ingestionRun.findFirst({ where, orderBy: { startedAt: "desc" }, select: { status: true, startedAt: true, finishedAt: true, errorMessage: true } }),
    ]);
    return { lastSuccessAt: success?.finishedAt ?? null, latestRun: summarise(latest) };
  };
  const [registrations, dissolved, statusReconcile, bulk, daily, officers, base, officerActivity, scheduler] = await Promise.all([
    pair({ kind: "new_registrations" }),
    pair({ kind: "advanced_search", inputName: { contains: DISSOLVED_MARK } }),
    pair({ kind: "advanced_search", inputName: { contains: "|adaptive", not: { contains: DISSOLVED_MARK } } }),
    pair({ kind: "bulk_csv" }),
    pair({ kind: "daily_update" }),
    pair({ kind: "officer_backfill" }),
    getDataFreshness(),
    // The officer worker heartbeats while it works, so the newest heartbeat is the latest activity.
    db.ingestionRun.findFirst({ where: { kind: "officer_backfill" }, orderBy: { heartbeatAt: "desc" }, select: { heartbeatAt: true } }),
    loadSchedulerStatus(),
  ]);
  return {
    registrations: { ...registrations, coveredThrough: base.registrationsThrough },
    dissolved,
    statusReconcile,
    bulk: { ...bulk, snapshot: base.bulkSnapshot },
    daily,
    officers: { ...officers, lastActivityAt: officerActivity?.heartbeatAt ?? null },
    scheduler,
  };
}
