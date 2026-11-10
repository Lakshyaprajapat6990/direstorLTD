// Read-only progress report for the officer (director) data import. No Companies House calls, no writes to the database.
//   npm run ch:officer-progress              one report; also remembers this snapshot so the NEXT report can show the measured rate
//   npm run ch:officer-progress -- --json    the same numbers as JSON
// The measured rate is the change since the previous snapshot (tmp-ingest/officer-progress.last.json); the ETA is shown at that
// measured rate, at the configured daily cap, and at the shared quota's background ceiling.
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { loadOfficerConfig } from "../src/lib/companies-house/officerQueue";
import { loadQuotaPolicy } from "../src/lib/companies-house/quota";
import { officerRequestsSpentToday } from "../src/lib/companies-house/officerWorker";

const SNAP = path.resolve("tmp-ingest/officer-progress.last.json");
const json = process.argv.includes("--json");
const n = (x: unknown) => Number(x ?? 0);
const fmt = (x: number) => Math.round(x).toLocaleString("en-GB");
const days = (d: number) => (!Number.isFinite(d) ? "n/a" : d < 1 ? `${(d * 24).toFixed(1)} hours` : `${d.toFixed(1)} days`);

async function main() {
  const now = new Date();
  const cfg = loadOfficerConfig();
  const policy = loadQuotaPolicy();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const [cov] = await db.$queryRaw<{ total: bigint; full: bigint; unavailable: bigint; none: bigint; active: bigint; active_none: bigint; active_done: bigint }[]>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE "officersCoverage" = 'full') AS "full",
           count(*) FILTER (WHERE "officersCoverage" = 'unavailable') AS unavailable,
           count(*) FILTER (WHERE "officersCoverage" = 'none') AS "none",
           count(*) FILTER (WHERE status = 'active') AS active,
           count(*) FILTER (WHERE status = 'active' AND "officersCoverage" = 'none') AS active_none,
           count(*) FILTER (WHERE status = 'active' AND "officersCoverage" <> 'none') AS active_done
    FROM "Company" WHERE source <> 'seed'`;
  const [dir] = await db.$queryRaw<{ rows: bigint; companies: bigint }[]>`SELECT count(*) AS rows, count(DISTINCT "companyId") AS companies FROM "Director"`;
  const jobs = await db.officerSyncJob.groupBy({ by: ["status"], _count: { _all: true } });
  const jobCount = (s: string) => jobs.find((j) => j.status === s)?._count._all ?? 0;

  const runs = await db.ingestionRun.findMany({ where: { kind: "officer_backfill", startedAt: { gte: dayStart } }, orderBy: { startedAt: "asc" }, select: { status: true, statsJson: true, startedAt: true, heartbeatAt: true, finishedAt: true } });
  const today = { runs: runs.length, processed: 0, full: 0, unavailable: 0, failures: 0, parked: 0, http429s: 0, handBacks: 0, requests: 0 };
  for (const r of runs) {
    try {
      const s = JSON.parse(r.statsJson ?? "{}");
      today.processed += n(s.processed); today.full += n(s.full); today.unavailable += n(s.unavailable); today.failures += n(s.failures);
      today.parked += n(s.parked); today.http429s += n(s.http429s); today.handBacks += n(s.systemicHandBacks); today.requests += n(s.requests);
    } catch { /* unreadable stats */ }
  }
  // The cap the worker is actually running with is recorded in its run stats (this shell's own setting may differ).
  for (const r of [...runs].reverse()) {
    try {
      const c = JSON.parse(r.statsJson ?? "{}").dailyRequestCap;
      if (typeof c === "number") { cfg.dailyRequestCap = c; break; }
    } catch { /* unreadable stats */ }
  }
  const spent = await officerRequestsSpentToday();
  const live = runs.filter((r) => r.status === "running" && now.getTime() - r.heartbeatAt.getTime() < 120_000);

  const stat = await db.$queryRaw<{ requests: bigint; ok: bigint; s404: bigint; s429: bigint; s5xx: bigint; net: bigint; auth: bigint }[]>`
    SELECT COALESCE(sum(requests),0) AS requests, COALESCE(sum(ok),0) AS ok, COALESCE(sum("status404"),0) AS s404, COALESCE(sum("status429"),0) AS s429,
           COALESCE(sum("status5xx"),0) AS s5xx, COALESCE(sum("networkErrors"),0) AS net, COALESCE(sum("statusAuth"),0) AS auth
    FROM "ChRequestStat" WHERE "bucketStart" >= CAST(${new Date(now.getTime() - 24 * 3_600_000).toISOString()} AS timestamp)`;
  const hourly = await db.$queryRaw<{ bucket: Date; cls: string; requests: bigint }[]>`
    SELECT "bucketStart" AS bucket, "quotaClass" AS cls, requests FROM "ChRequestStat"
    WHERE "bucketStart" >= CAST(${new Date(now.getTime() - 3 * 3_600_000).toISOString()} AS timestamp) AND "quotaClass" IN ('backfill','refresh','user') ORDER BY 1 DESC, 2`;

  const done = n(cov.full) + n(cov.unavailable);
  const snap = { at: now.toISOString(), done, activeNone: n(cov.active_none), dirRows: n(dir.rows), requestsToday: spent };
  let prev: typeof snap | null = null;
  try { prev = JSON.parse(fs.readFileSync(SNAP, "utf8")); } catch { /* first report */ }
  let perMin: number | null = null;
  if (prev) {
    const mins = (now.getTime() - new Date(prev.at).getTime()) / 60_000;
    if (mins >= 1) perMin = (snap.done - prev.done) / mins;
  }
  fs.mkdirSync(path.dirname(SNAP), { recursive: true });
  fs.writeFileSync(SNAP, JSON.stringify(snap));

  const backlog = n(cov.active_none);
  const quotaCeilingPerMin = (policy.limit - policy.headroom - policy.idleFloor.user - policy.idleFloor.filing - policy.idleFloor.stream - policy.idleFloor.refresh) / (policy.windowMs / 60_000);
  const capPerDay = cfg.dailyRequestCap > 0 ? cfg.dailyRequestCap : Infinity;
  const eta = {
    atMeasuredRate: perMin && perMin > 0 ? backlog / perMin / 1440 : NaN,
    atDailyCap: Number.isFinite(capPerDay) ? backlog / capPerDay : NaN,
    atQuotaCeiling: backlog / (quotaCeilingPerMin * 1440),
  };

  const report = {
    at: now.toISOString(),
    worker: { liveRuns: live.length, lastRun: runs.at(-1)?.status ?? null },
    coverage: { companies: n(cov.total), withOfficerData: done, confirmed: n(cov.full), unavailable: n(cov.unavailable), pending: n(cov.none) },
    active: { total: n(cov.active), withOfficerData: n(cov.active_done), backlog },
    directors: { records: n(dir.rows), companiesWithRecords: n(dir.companies) },
    queue: { queued: jobCount("queued"), retry: jobCount("retry"), leased: jobCount("leased"), parked: jobCount("parked") },
    today: { ...today, requestsRecorded: spent, dailyCap: cfg.dailyRequestCap },
    api24h: { requests: n(stat[0].requests), ok: n(stat[0].ok), notFound404: n(stat[0].s404), http429: n(stat[0].s429), http5xx: n(stat[0].s5xx), networkErrors: n(stat[0].net), authErrors: n(stat[0].auth) },
    hourlyRequests: hourly.map((h) => ({ hourUtc: h.bucket.toISOString().slice(0, 13), class: h.cls, requests: n(h.requests) })),
    rate: { measuredCompaniesPerMin: perMin === null ? null : Math.round(perMin * 10) / 10, sinceMinutes: prev ? Math.round((now.getTime() - new Date(prev.at).getTime()) / 60_000) : null, quotaCeilingPerMin: Math.round(quotaCeilingPerMin * 10) / 10 },
    etaDays: { atMeasuredRate: eta.atMeasuredRate, atDailyCap: eta.atDailyCap, atQuotaCeiling: eta.atQuotaCeiling },
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`OFFICER DATA PROGRESS  ${report.at}`);
    console.log(`  worker            : ${live.length ? "RUNNING" : "idle / between runs"} (runs today: ${today.runs}, last: ${report.worker.lastRun ?? "-"})`);
    console.log(`  companies         : ${fmt(report.coverage.companies)} total | with officer data ${fmt(done)} (confirmed ${fmt(report.coverage.confirmed)}, unavailable ${fmt(report.coverage.unavailable)}) | pending ${fmt(report.coverage.pending)}`);
    console.log(`  ACTIVE companies  : ${fmt(report.active.total)} | with officer data ${fmt(report.active.withOfficerData)} | backlog ${fmt(backlog)} (${((report.active.withOfficerData / Math.max(1, report.active.total)) * 100).toFixed(2)}% done)`);
    console.log(`  director records  : ${fmt(report.directors.records)} across ${fmt(report.directors.companiesWithRecords)} companies`);
    console.log(`  queue             : queued ${report.queue.queued}, retrying ${report.queue.retry}, leased ${report.queue.leased}, parked ${report.queue.parked}`);
    console.log(`  today (UTC)       : processed ${fmt(today.processed)} (confirmed ${today.full}, unavailable ${today.unavailable}, failed ${today.failures}, parked ${today.parked}); requests ${fmt(spent)} of cap ${cfg.dailyRequestCap || "none"}; 429s ${today.http429s}; outage/quota hand-backs ${today.handBacks}`);
    console.log(`  API last 24h      : ${fmt(report.api24h.requests)} requests | ok ${fmt(report.api24h.ok)} | 404 ${fmt(report.api24h.notFound404)} | 429 ${report.api24h.http429} | 5xx ${report.api24h.http5xx} | network errors ${report.api24h.networkErrors} | auth ${report.api24h.authErrors}`);
    console.log(`  rate              : ${report.rate.measuredCompaniesPerMin === null ? "no previous snapshot yet" : `${report.rate.measuredCompaniesPerMin} companies/min over the last ${report.rate.sinceMinutes} min`} (shared-quota ceiling for background work ~${report.rate.quotaCeilingPerMin}/min)`);
    console.log(`  ETA for ${fmt(backlog)} active: at measured rate ${days(eta.atMeasuredRate)} | at daily cap ${days(eta.atDailyCap)} | at quota ceiling ${days(eta.atQuotaCeiling)}`);
  }
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e); await db.$disconnect().catch(() => {}); process.exit(1); });
