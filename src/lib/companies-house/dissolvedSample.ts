import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { CompaniesHouseApiError, CompaniesHouseBreakerOpenError, CompaniesHouseQuotaDeferredError, CompaniesHouseRateLimitError } from "@/lib/companies-house/client";
import { DIRECTOR_ROLES, LLP_MEMBER_ROLES } from "@/lib/companies-house/officers";
import { syncCompanyOfficers } from "@/lib/companies-house/sync";
import { estimateDissolvedFromSample } from "@/lib/data/director-progress-calc";

// A stratified RANDOM sample of never-checked DISSOLVED companies (one stratum per dissolution year), fetched in controlled batches, to estimate
// how many director / LLP-member records the unchecked dissolved companies hold. Methodology: see estimateDissolvedFromSample.
//   - Draw: for each year, a simple random sample (ORDER BY random()) of the dissolved, non-seed companies whose officers have NEVER been checked
//     and that are not already in the sample. A re-run only tops each year up to the target, so it can never duplicate or re-draw.
//   - Fetch: through the normal officer path (syncCompanyOfficers): the Director rows of a company are replaced as one set in one transaction, so
//     there are never duplicates, and only companies that were never checked are fetched, so no existing officer data is ever replaced.
//   - Requests: every request goes through the shared quota gate and is recorded in the shared ledger by the client itself (awaited before the
//     response is used); a run also stops before the daily cap (with a reserve) and after a request budget, and on any 429 / breaker / quota hand-back.

export const SAMPLE_PER_YEAR = 150;
export const FIRST_STRATUM = 2009; // before 2010 or no dissolution date
const ROLES = [...DIRECTOR_ROLES, ...LLP_MEMBER_ROLES];

/** SQL predicate: the company belongs to the dissolution-year stratum `year` (the same grouping as the estimator: 2009 = before 2010 / no date). */
export function stratumPredicate(year: number): Prisma.Sql {
  return year <= FIRST_STRATUM
    ? Prisma.sql`(c."dissolutionDate" IS NULL OR c."dissolutionDate" < '2010-01-01')`
    : Prisma.sql`(c."dissolutionDate" >= ${`${year}-01-01`}::date AND c."dissolutionDate" < ${`${year + 1}-01-01`}::date)`;
}
const FRAME = Prisma.sql`c."source" <> 'seed' AND c."status" = 'dissolved' AND c."officersCoverage" = 'none' AND NOT EXISTS (SELECT 1 FROM "DissolvedSample" s WHERE s."companyId" = c."id")`;

export async function dissolvedYears(): Promise<number[]> {
  const r = await db.$queryRaw<{ y: number | null }[]>`SELECT max(extract(year FROM "dissolutionDate"))::int AS y FROM "Company" WHERE "status" = 'dissolved' AND "source" <> 'seed'`;
  const max = Math.max(FIRST_STRATUM, r[0]?.y ?? FIRST_STRATUM);
  return Array.from({ length: max - FIRST_STRATUM + 1 }, (_, i) => FIRST_STRATUM + i);
}

export interface DrawResult {
  year: number;
  frame: number; // never-checked, not-yet-sampled dissolved companies of the year before this draw
  existing: number; // already in the sample
  drawn: number;
}

/** Top every year up to `perYear` randomly selected companies. Idempotent: a second call draws nothing more. Writes only DissolvedSample rows. */
export async function drawSample(options: { perYear?: number; batch: string; kind?: "pilot" | "full"; years?: number[] }): Promise<DrawResult[]> {
  const perYear = options.perYear ?? SAMPLE_PER_YEAR;
  const kind = options.kind ?? "full";
  const out: DrawResult[] = [];
  for (const year of options.years ?? (await dissolvedYears())) {
    const existing = await db.dissolvedSample.count({ where: { stratum: year } });
    const need = Math.max(0, perYear - existing);
    const frame = Number((await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM "Company" c WHERE ${FRAME} AND ${stratumPredicate(year)}`))[0].n);
    let drawn = 0;
    if (need > 0 && frame > 0) {
      drawn = await db.$executeRaw(Prisma.sql`
        INSERT INTO "DissolvedSample" ("companyId", "stratum", "kind", "batch", "frameSize", "status")
        SELECT c."id", ${year}, ${kind}, ${options.batch}, ${frame + existing}, 'selected'
          FROM "Company" c WHERE ${FRAME} AND ${stratumPredicate(year)}
         ORDER BY random() LIMIT ${need}
        ON CONFLICT ("companyId") DO NOTHING`);
    }
    out.push({ year, frame, existing, drawn });
  }
  return out;
}

const qualifying = (companyId: string) => db.director.count({ where: { companyId, role: { in: ROLES } } });

/** Tag companies that were fetched earlier as a random draw (the 54-company pilot) as sample members; their stored results become the sample values. */
export async function tagPilot(companyIds: string[], batch = "pilot-v1"): Promise<{ tagged: number; skipped: string[] }> {
  let tagged = 0;
  const skipped: string[] = [];
  for (const id of companyIds) {
    const c = await db.company.findUnique({ where: { id }, select: { status: true, dissolutionDate: true, officersCoverage: true, source: true } });
    if (!c || c.status !== "dissolved" || c.source === "seed" || c.officersCoverage === "none") { skipped.push(id); continue; }
    const year = c.dissolutionDate ? Math.max(FIRST_STRATUM, c.dissolutionDate.getUTCFullYear()) : FIRST_STRATUM;
    const frame = Number((await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM "Company" c WHERE ${FRAME} AND ${stratumPredicate(year)}`))[0].n);
    const pilots = await db.dissolvedSample.count({ where: { stratum: year } });
    const records = await qualifying(id);
    const all = await db.director.count({ where: { companyId: id } });
    const res = await db.dissolvedSample.createMany({
      data: [{ companyId: id, stratum: year, kind: "pilot", batch, frameSize: frame + pilots + 1, status: c.officersCoverage === "full" ? "fetched" : "unavailable", records, requests: c.officersCoverage === "full" ? Math.max(1, Math.ceil(all / 100)) : 2, attempts: 1, fetchedAt: new Date() }],
      skipDuplicates: true,
    });
    tagged += res.count;
  }
  return { tagged, skipped };
}

export interface SampleRunReport {
  attempted: number;
  fetched: number;
  unavailable: number;
  alreadyChecked: number;
  failed: number;
  requests: number; // requests sent by this run (derived exactly: one per 100 officers, or the officers + profile pair for an unavailable company)
  stopReason: "done" | "budget" | "cap" | "quota" | "breaker" | "http_429" | "errors";
}

/** Ledger requests of every class since 00:00 UTC: the same figure the dashboard shows. */
export async function requestsSpentToday(now: Date = new Date()): Promise<number> {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const r = await db.chRequestStat.aggregate({ where: { bucketStart: { gte: day } }, _sum: { requests: true } });
  return r._sum.requests ?? 0;
}

/** Fetch selected sample companies in controlled batches. Stops at the request budget, before the daily cap (with a reserve), and on any hand-back. */
export async function runSampleBatches(options: { batchSize?: number; maxRequests: number; dailyCap: number | null; reserve?: number; pauseMs?: number; signal?: AbortSignal; log?: (m: string) => void }): Promise<SampleRunReport> {
  const log = options.log ?? (() => {});
  const batchSize = options.batchSize ?? 100;
  const reserve = options.reserve ?? (options.dailyCap ? Math.max(1_000, Math.round(options.dailyCap * 0.05)) : 0);
  const rep: SampleRunReport = { attempted: 0, fetched: 0, unavailable: 0, alreadyChecked: 0, failed: 0, requests: 0, stopReason: "done" };
  await db.$executeRaw`UPDATE "DissolvedSample" SET "status" = 'selected', "claimedAt" = NULL WHERE "status" = 'fetching' AND "claimedAt" < now() - interval '15 minutes'`;
  let consecutiveErrors = 0;
  for (;;) {
    if (options.signal?.aborted) { rep.stopReason = "budget"; break; }
    if (rep.requests + 2 > options.maxRequests) { rep.stopReason = "budget"; break; }
    if (options.dailyCap && (await requestsSpentToday()) + 2 > options.dailyCap - reserve) { rep.stopReason = "cap"; break; }
    // claim a batch atomically (a second runner can never take the same companies)
    const claimed = await db.$queryRaw<{ companyId: string; stratum: number }[]>(Prisma.sql`
      UPDATE "DissolvedSample" SET "status" = 'fetching', "claimedAt" = now(), "attempts" = "attempts" + 1
       WHERE "companyId" IN (SELECT "companyId" FROM "DissolvedSample" WHERE ("status" = 'selected' OR ("status" = 'failed' AND "attempts" < 3))
                              ORDER BY "stratum", "companyId" LIMIT ${Math.min(batchSize, Math.max(1, Math.floor((options.maxRequests - rep.requests) / 2)))} FOR UPDATE SKIP LOCKED)
      RETURNING "companyId", "stratum"`);
    if (!claimed.length) { rep.stopReason = "done"; break; }
    let stop: SampleRunReport["stopReason"] | null = null;
    for (const row of claimed) {
      if (stop) { await db.dissolvedSample.update({ where: { companyId: row.companyId }, data: { status: "selected", claimedAt: null, attempts: { decrement: 1 } } }); continue; }
      const company = await db.company.findUniqueOrThrow({ where: { id: row.companyId }, select: { companyNumber: true, officersCoverage: true } });
      rep.attempted++;
      try {
        if (company.officersCoverage !== "none") {
          // checked by something else after the draw: use what is stored, spend nothing, replace nothing
          await db.dissolvedSample.update({ where: { companyId: row.companyId }, data: { status: "already_checked", records: await qualifying(row.companyId), claimedAt: null, fetchedAt: new Date(), lastError: null } });
          rep.alreadyChecked++;
          continue;
        }
        const outcome = await syncCompanyOfficers(row.companyId, company.companyNumber, { quotaClass: "backfill" });
        const all = await db.director.count({ where: { companyId: row.companyId } });
        const requests = outcome.kind === "full" ? Math.max(1, Math.ceil(all / 100)) : 2;
        rep.requests += requests;
        const status = outcome.kind === "full" ? "fetched" : "unavailable";
        await db.dissolvedSample.update({ where: { companyId: row.companyId }, data: { status, records: outcome.kind === "full" ? await qualifying(row.companyId) : 0, requests: { increment: requests }, claimedAt: null, fetchedAt: new Date(), lastError: null } });
        if (status === "fetched") rep.fetched++; else rep.unavailable++;
        consecutiveErrors = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
        await db.dissolvedSample.update({ where: { companyId: row.companyId }, data: { status: "failed", claimedAt: null, lastError: msg } });
        rep.failed++;
        rep.requests += 1; // a failed attempt may have used a request: counted, so the budget is never understated
        consecutiveErrors++;
        if (err instanceof CompaniesHouseQuotaDeferredError) stop = "quota";
        else if (err instanceof CompaniesHouseBreakerOpenError) stop = "breaker";
        else if (err instanceof CompaniesHouseRateLimitError || (err instanceof CompaniesHouseApiError && err.status === 429)) stop = "http_429";
        else if (consecutiveErrors >= 5) stop = "errors";
      }
      if (options.pauseMs) await new Promise((r) => setTimeout(r, options.pauseMs));
    }
    log(`batch done: ${rep.attempted} attempted, ${rep.fetched} fetched, ${rep.unavailable} unavailable, ${rep.alreadyChecked} already checked, ${rep.failed} failed, ${rep.requests} requests`);
    if (stop) { rep.stopReason = stop; break; }
  }
  return rep;
}

export { loadSampleStrata } from "@/lib/data/director-progress";
export { estimateDissolvedFromSample };
