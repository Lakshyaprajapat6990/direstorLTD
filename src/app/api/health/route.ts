import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { effectiveStatus } from "@/lib/jobs/runs";
import { isRestConfigured, isStreamConfigured } from "@/lib/companies-house/client";
import { getDataFreshness, getIngestionFreshness } from "@/lib/data/freshness";
import { evaluateHealth } from "@/lib/jobs/health";

export const dynamic = "force-dynamic";

// Liveness / readiness for load balancers and uptime monitors.
//   - public: { status: "ok" | "degraded" } only - HTTP 503 if the database is unreachable
//   - Super Admin session: adds job health (scheduler heartbeat, per-source freshness, stalled / failed jobs, pending DS01 events)
// "degraded" means the app is serving but a background job needs attention (see src/lib/jobs/health.ts for the exact rules).
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    return NextResponse.json({ status: "down", db: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const [streamRun, checkpoint, pendingEvents, runs, ingestion, freshness] = await Promise.all([
    db.ingestionRun.findFirst({ where: { kind: "stream" }, orderBy: { startedAt: "desc" } }),
    db.streamCheckpoint.findUnique({ where: { name: "filings" } }),
    db.filingEvent.count({ where: { applyStatus: "pending", type: { in: ["DS01", "DS02"] } } }),
    db.ingestionRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }),
    getIngestionFreshness(),
    getDataFreshness(),
  ]);

  const now = new Date();
  const streamStatus = streamRun ? effectiveStatus(streamRun) : "never";
  const lastEventAgeSeconds = checkpoint?.lastEventAt ? Math.round((now.getTime() - checkpoint.lastEventAt.getTime()) / 1000) : null;
  const stalledJobs = runs.filter((r) => effectiveStatus(r) === "stalled").length;
  const registrationsLagDays = ingestion.registrations.coveredThrough ? Math.floor((now.getTime() - Date.parse(ingestion.registrations.coveredThrough + "T00:00:00Z")) / 86_400_000) : null;

  const verdict = evaluateHealth({
    now,
    freshness: ingestion,
    schedulerExpected: process.env.SCHEDULER_EXPECTED === "1",
    restConfigured: isRestConfigured(),
    stalledJobs,
    pendingDs01Events: pendingEvents,
    stream: { configured: isStreamConfigured(), status: streamStatus, lastEventAgeSeconds },
  });

  const session = await getSession();
  const body: Record<string, unknown> = { status: verdict.degraded ? "degraded" : "ok", db: true };
  if (session?.role === "SUPER_ADMIN") {
    body.jobs = {
      reasons: verdict.reasons,
      scheduler: {
        alive: ingestion.scheduler.alive,
        neverSeen: ingestion.scheduler.neverSeen,
        jobs: ingestion.scheduler.jobs,
        lastHeartbeatAt: ingestion.scheduler.lastHeartbeatAt,
        instances: ingestion.scheduler.instances,
      },
      stream: { configured: isStreamConfigured(), status: streamStatus, lastEventAgeSeconds, checkpoint: checkpoint ? Number(checkpoint.timepoint) : null },
      stalledJobs,
      dataFreshness: { lastUpdated: freshness.lastUpdated, registrationsThrough: freshness.registrationsThrough, registrationsLagDays, bulkSnapshot: freshness.bulkSnapshot },
      sources: {
        registrations: ingestion.registrations,
        dissolved: ingestion.dissolved,
        statusReconcile: ingestion.statusReconcile,
        bulk: ingestion.bulk,
        daily: ingestion.daily,
        officers: ingestion.officers,
      },
      pendingDs01Events: pendingEvents,
      latestFailed: runs.filter((r) => r.status === "failed").slice(0, 3).map((r) => ({ kind: r.kind, at: r.startedAt, error: r.errorMessage?.slice(0, 200) ?? null })),
    };
  }
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
