import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { chRestGet, CompaniesHouseBreakerOpenError, CompaniesHouseNotFoundError, CompaniesHouseRateLimitError } from "./client";
import { enqueueOfficerJobs, OFFICER_PRIORITY } from "./officerQueue";
import { parseChDate } from "./csv/dates";
import { normalisePostcode } from "./csv/mapping";
import { isNonUkCompany } from "./eligibility";
import { classifyRun, ErrorSampler, finishRun, startRun, touchRun } from "@/lib/jobs/runs";

// New-registration sync: keeps the register current BETWEEN the monthly bulk files.
//
// The monthly Companies House snapshot is published within 5 working days of month end and covers companies up to the end
// of the previous month, so on its own the newest registrations are always missing. This job asks Companies House
// Advanced Search for the companies incorporated on each day of a window (incorporated_from == incorporated_to == the day):
//   - one request per day (about 2,500-3,500 companies on a weekday, the API returns up to 5,000 per request);
//   - every company_status is returned (no status filter), with SIC codes, type, address and incorporation date;
//   - repeatable and idempotent: companies are inserted once (unique company number) and a re-run only refreshes them;
//   - self-healing: the window starts at the last fully covered day (minus a small overlap), so a failed or missed run is
//     recovered by the next one without any manual step.
// Rows held from the live stream / a full REST profile are never overwritten (they are richer than a search hit).
// It does not know accounts due dates, dormant, officers or strike-off detail: those stay at their defaults until the
// monthly bulk file or a full profile fetch fills them in (exactly as for any stream-created company).

const SEARCH_PATH = "/advanced-search/companies";
const PAGE_SIZE = 5000; // documented maximum for `size`
// Re-fetch this many already-covered days each run: a company can appear in search a little after its incorporation day.
export const OVERLAP_DAYS = 2;
// Never look back further than this in one run (a long outage is recovered by the monthly bulk file instead).
export const MAX_LOOKBACK_DAYS = 120;
const DAY_MS = 86_400_000;

export interface NewRegistrationsOptions {
  from?: string; // YYYY-MM-DD, inclusive (default: resume point)
  to?: string; // YYYY-MM-DD, inclusive (default: today, UTC)
  signal?: AbortSignal;
  log?: (msg: string) => void;
  // Test seam: replaces the Companies House request (default: the live, quota-gated search).
  fetcher?: DayFetcher;
}

export interface NewRegistrationsResult {
  runId: string;
  status: string;
  from: string;
  to: string;
  coveredThrough: string | null;
  daysCovered: number;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  error: string | null;
}

interface AdvancedSearchItem {
  company_number: string;
  company_name: string;
  company_status: string;
  company_type: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  sic_codes?: string[];
  registered_office_address?: { address_line_1?: string; address_line_2?: string; locality?: string; region?: string; postal_code?: string };
}
interface AdvancedSearchResponse {
  items?: AdvancedSearchItem[];
  hits?: number;
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS));
const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

// Pure: which days to ask for. `resumeFrom` is the first day not yet known to be covered.
export function planWindow(input: { today: string; from?: string; to?: string; lastCovered?: string | null; bulkSnapshot?: string | null }): { from: string; to: string } {
  // Never beyond today: a typo or a future date must not push the resume point into the future.
  const to = input.to && input.to < input.today ? input.to : input.today;
  let from: string;
  if (input.from) from = input.from;
  else if (input.lastCovered) from = addDays(input.lastCovered, 1 - OVERLAP_DAYS);
  // First ever run: the monthly file dated D covers up to the end of the previous month, so D itself is the first uncovered day.
  else if (input.bulkSnapshot) from = input.bulkSnapshot;
  else from = addDays(to, -30);
  const floor = addDays(to, -MAX_LOOKBACK_DAYS);
  if (from < floor) from = floor;
  return { from, to };
}

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Pure: a search hit as a Company row, or the reason it cannot be stored.
export function mapSearchItem(item: AdvancedSearchItem): { ok: true; data: Prisma.CompanyCreateManyInput } | { ok: false; reason: string; ineligible?: true } {
  // UK companies only (see eligibility.ts): overseas entities, overseas companies and UK establishments registered that day are left out.
  if (isNonUkCompany({ companyNumber: item.company_number, type: item.company_type })) return { ok: false, reason: "not a UK company", ineligible: true };
  const incorporationDate = parseChDate(item.date_of_creation);
  if (!incorporationDate) return { ok: false, reason: "missing/invalid date_of_creation" };
  if (!item.company_number || !item.company_name || !item.company_status || !item.company_type) return { ok: false, reason: "missing required field" };
  const a = item.registered_office_address;
  return {
    ok: true,
    data: {
      companyNumber: item.company_number.toUpperCase(),
      name: item.company_name,
      status: item.company_status,
      type: item.company_type,
      incorporationDate,
      dissolutionDate: parseChDate(item.date_of_cessation),
      sicCodes: (item.sic_codes ?? []).join(","),
      registeredAddress1: a?.address_line_1 ?? "",
      registeredAddress2: a?.address_line_2 ?? null,
      registeredCity: a?.locality ?? "",
      registeredPostcode: normalisePostcode(a?.postal_code ?? ""),
      registeredCounty: a?.region ?? null,
      source: "advanced_search",
      chLastFetchedAt: new Date(),
    },
  };
}

export interface DayFilter {
  company_status?: string;
  company_type?: string;
  // Control reads only: widens the window to `day` .. `through` (default: the single day).
  through?: string;
}

// Companies House itself has genuinely empty days (13 and 14 June 2026 are absent from its own monthly file). A finished day with
// no registrations is therefore accepted as covered only when BOTH hold: it is older than this many days (search results can lag
// the incorporation date, so a recent empty day is retried instead), and a control read of the preceding week proves the search
// is answering with real data. Otherwise it is refused, exactly like any other incomplete day.
export const EMPTY_DAY_CONFIRM_AFTER_DAYS = 2;
export const EMPTY_DAY_CONTROL_DAYS = 7;
export type DayFetcher = (day: string, filter: DayFilter) => Promise<AdvancedSearchResponse>;

// A day with more than one response page of registrations (5,000) cannot be paged: start_index beyond the first page errors. It is
// therefore read as disjoint slices - by company_status, and any slice that is still too large by company_type. Completeness is
// PROVED, never assumed: the slice totals must add up exactly to the day's total, and every leaf slice must have been read in full.
// If the numbers do not reconcile (a status or type missing from these lists, or a slice that is still too big) the day throws and
// is NOT covered, so the checkpoint cannot claim a hole is filled.
export const SPLIT_STATUSES = ["active", "dissolved", "liquidation", "administration", "receivership", "voluntary-arrangement", "insolvency-proceedings", "converted-closed", "closed", "open", "registered", "removed"];
export const SPLIT_TYPES = [
  "ltd", "plc", "llp", "private-limited-guarant-nsc", "private-limited-guarant-nsc-limited-exemption", "private-unlimited", "private-unlimited-nsc",
  "limited-partnership", "scottish-partnership", "royal-charter", "industrial-and-provident-society", "registered-society-non-jurisdictional",
  "charitable-incorporated-organisation", "scottish-charitable-incorporated-organisation", "northern-ireland", "northern-ireland-other",
  "old-public-company", "protected-cell-company", "assurance-company", "investment-company-with-variable-capital", "icvc-securities", "icvc-warrant",
  "icvc-umbrella", "unregistered-company", "european-public-limited-liability-co-se", "eeig", "converted-or-closed", "oversea-company",
  "uk-establishment", "registered-overseas-entity", "further-education-or-sixth-form-college-corp", "other",
];

export async function readDayComplete(day: string, fetcher: DayFetcher): Promise<{ items: AdvancedSearchItem[]; hits: number; requests: number; split: boolean }> {
  const top = await fetcher(day, {});
  const topItems = top.items ?? [];
  const hits = top.hits ?? topItems.length;
  if (hits <= topItems.length) return { items: topItems, hits, requests: 1, split: false };

  let requests = 1;
  const byNumber = new Map<string, AdvancedSearchItem>();
  const add = (items: AdvancedSearchItem[]) => items.forEach((i) => byNumber.set(i.company_number, i));
  let statusSum = 0;
  for (const status of SPLIT_STATUSES) {
    const r = await fetcher(day, { company_status: status });
    requests++;
    const items = r.items ?? [];
    const h = r.hits ?? items.length;
    if (h === 0) continue;
    if (h <= items.length) {
      add(items);
      statusSum += h;
      continue;
    }
    let typeSum = 0;
    for (const type of SPLIT_TYPES) {
      const rr = await fetcher(day, { company_status: status, company_type: type });
      requests++;
      const ii = rr.items ?? [];
      const hh = rr.hits ?? ii.length;
      if (hh > ii.length) throw new Error(`${day}: status "${status}" / type "${type}" still has ${hh} matches but only ${ii.length} could be read`);
      add(ii);
      typeSum += hh;
    }
    if (typeSum !== h) throw new Error(`${day}: status "${status}" split by type accounts for ${typeSum} of ${h} companies; not claiming coverage`);
    statusSum += h;
  }
  if (statusSum !== hits) throw new Error(`${day}: ${hits} companies match but the split by status accounts for ${statusSum}; not claiming coverage`);
  return { items: [...byNumber.values()], hits, requests, split: true };
}

// The real fetcher: every request goes through the shared quota gate (class "backfill"). Companies House answers 404 for a search
// with no matches (see dissolvedImport.ts), which is an empty slice, not an error.
function liveFetcher(signal?: AbortSignal): DayFetcher {
  return async (day, filter) => {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        return await chRestGet<AdvancedSearchResponse>(SEARCH_PATH, {
          params: { incorporated_from: day, incorporated_to: filter.through ?? day, company_status: filter.company_status, company_type: filter.company_type, size: PAGE_SIZE, start_index: 0 },
          quotaClass: "backfill",
          maxQuotaWaitMs: 5 * 60_000,
          timeoutMs: 120_000,
        });
      } catch (err) {
        if (err instanceof CompaniesHouseNotFoundError) return { items: [], hits: 0 };
        if (err instanceof CompaniesHouseRateLimitError && attempt < 4) {
          await new Promise((r) => setTimeout(r, Math.max(1000, err.retryAfterMs)));
          continue;
        }
        throw err;
      }
    }
  };
}

// Stores one day. Returns the counters. Throws if the day cannot be stored completely (then the day is NOT covered).
export async function storeDay(day: string, signal?: AbortSignal, fetcher: DayFetcher = liveFetcher(signal)) {
  const { items, hits } = await readDayComplete(day, fetcher);
  // An empty answer for a finished day usually means the search is broken, not that nothing happened. It is accepted as genuinely
  // empty only when the day is old enough AND a control read of the preceding week returns data (see EMPTY_DAY_CONFIRM_AFTER_DAYS);
  // otherwise it is refused and the next run retries it. Today may legitimately be empty just after midnight UTC.
  let confirmedEmpty = false;
  if (hits === 0 && day < isoDay(new Date())) {
    const tooRecent = day > addDays(isoDay(new Date()), -EMPTY_DAY_CONFIRM_AFTER_DAYS - 1);
    const control = tooRecent ? null : await fetcher(addDays(day, -EMPTY_DAY_CONTROL_DAYS), { through: addDays(day, -1) });
    if (tooRecent) throw new Error(`${day}: Companies House returned no registrations for a finished day (too recent to treat as genuinely empty); not claiming coverage`);
    if (!control || (control.hits ?? control.items?.length ?? 0) === 0) {
      throw new Error(`${day}: Companies House returned no registrations for a finished day and the preceding ${EMPTY_DAY_CONTROL_DAYS} days also returned none (the search looks broken); not claiming coverage`);
    }
    confirmedEmpty = true;
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let ineligible = 0;
  let queuedOfficers = 0;
  const samples = new ErrorSampler(10);
  const mapped: Prisma.CompanyCreateManyInput[] = [];
  items.forEach((item, i) => {
    const m = mapSearchItem(item);
    if (m.ok) mapped.push(m.data);
    else if (m.ineligible) ineligible++; // not a UK company: left out by design, not a skipped/failed row
    else {
      skipped++;
      samples.add(i, m.reason, item.company_number);
    }
  });

  for (let i = 0; i < mapped.length; i += 500) {
    const chunk = mapped.slice(i, i + 500);
    const numbers = chunk.map((c) => c.companyNumber);
    const existing = await db.company.findMany({ where: { companyNumber: { in: numbers } }, select: { companyNumber: true, source: true } });
    const known = new Map(existing.map((e) => [e.companyNumber, e.source]));
    const fresh = chunk.filter((c) => !known.has(c.companyNumber));
    if (fresh.length) {
      // skipDuplicates makes a concurrent writer (the stream creating the same company) harmless.
      const r = await db.company.createMany({ data: fresh, skipDuplicates: true });
      inserted += r.count;
      // Newly registered live companies enter the officer queue so their directors are fetched within a day or two, ahead of the
      // general crawl (lowest queue priority, "backfill" quota class, and still bounded by the officer worker's daily request cap).
      // Best effort: the company rows are already stored, so a queue failure must never fail (or un-cover) the day.
      await queueNewCompaniesForOfficers(fresh.filter((c) => c.status === "active").map((c) => c.companyNumber))
        .then((n) => (queuedOfficers += n))
        .catch(() => {});
    }
    // Existing rows from the bulk file or an earlier search are refreshed; stream / full-profile rows are left alone.
    for (const c of chunk) {
      const src = known.get(c.companyNumber);
      if (src !== "bulk_import" && src !== "advanced_search") continue;
      await db.company.update({
        where: { companyNumber: c.companyNumber },
        data: {
          name: c.name,
          status: c.status,
          type: c.type,
          dissolutionDate: c.dissolutionDate,
          sicCodes: c.sicCodes,
          registeredAddress1: c.registeredAddress1,
          registeredAddress2: c.registeredAddress2,
          registeredCity: c.registeredCity,
          registeredPostcode: c.registeredPostcode,
          registeredCounty: c.registeredCounty,
          // Only rows this job owns carry its fetch time; a bulk row's provenance and fetch state are not touched.
          ...(src === "advanced_search" ? { chLastFetchedAt: new Date() } : {}),
        },
      });
      updated++;
    }
  }
  return { read: items.length, inserted, updated, skipped, ineligible, queuedOfficers, confirmedEmpty, samples: samples.toJson() };
}

// Queues officer fetching for newly stored active companies (NEW_REGISTRATIONS_QUEUE_OFFICERS=0 turns it off;
// NEW_REGISTRATIONS_OFFICER_CAP bounds how many one day may queue, default 10,000). Idempotent: one queue row per company.
export async function queueNewCompaniesForOfficers(companyNumbers: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (env.NEW_REGISTRATIONS_QUEUE_OFFICERS === "0" || companyNumbers.length === 0) return 0;
  const cap = Number.isFinite(Number(env.NEW_REGISTRATIONS_OFFICER_CAP)) && Number(env.NEW_REGISTRATIONS_OFFICER_CAP) > 0 ? Number(env.NEW_REGISTRATIONS_OFFICER_CAP) : 10_000;
  const rows = await db.company.findMany({ where: { companyNumber: { in: companyNumbers }, status: "active", officersCoverage: "none", source: { not: "seed" } }, select: { id: true } });
  if (rows.length === 0) return 0;
  const r = await enqueueOfficerJobs(rows.map((x) => x.id), { priority: OFFICER_PRIORITY.PREFETCH, reason: "new_registration", cap });
  return r.inserted;
}

async function resumePoint(): Promise<{ lastCovered: string | null; bulkSnapshot: string | null }> {
  const last = await db.ingestionRun.findFirst({ where: { kind: "new_registrations", checkpoint: { not: null, lte: isoDay(new Date()) } }, orderBy: { checkpoint: "desc" }, select: { checkpoint: true } });
  const lastCovered = last?.checkpoint && validDay(last.checkpoint) ? last.checkpoint : null;
  let bulkSnapshot: string | null = null;
  if (!lastCovered) {
    const bulk = await db.ingestionRun.findFirst({ where: { kind: "bulk_csv", status: { in: ["success", "partial"] } }, orderBy: { startedAt: "desc" }, select: { statsJson: true } });
    try {
      const s = bulk?.statsJson ? (JSON.parse(bulk.statsJson) as { snapshotDate?: string | null }).snapshotDate : null;
      if (s && validDay(s)) bulkSnapshot = s;
    } catch {
      /* unreadable stats: fall back to the default window */
    }
  }
  return { lastCovered, bulkSnapshot };
}

export async function syncNewRegistrations(options: NewRegistrationsOptions = {}): Promise<NewRegistrationsResult> {
  const log = options.log ?? (() => {});
  for (const d of [options.from, options.to]) if (d && !validDay(d)) throw new Error(`Invalid date "${d}" (use YYYY-MM-DD)`);
  const today = isoDay(new Date());
  const { lastCovered, bulkSnapshot } = await resumePoint();
  const { from, to } = planWindow({ today, from: options.from, to: options.to, lastCovered, bulkSnapshot });
  const days = from <= to ? daysBetween(from, to) : [];
  log(`New registrations: ${from} to ${to} (${days.length} day(s))${lastCovered ? `, resuming after ${lastCovered}` : ""}`);

  const run = await startRun("new_registrations", { inputName: `${from}..${to}` });
  const totals = { read: 0, inserted: 0, updated: 0, skipped: 0 };
  let covered: string | null = null;
  let daysCovered = 0;
  let error: string | null = null;
  let samples: string | null = null;

  for (const day of days) {
    if (options.signal?.aborted) {
      error = "aborted";
      break;
    }
    try {
      const r = await storeDay(day, options.signal, options.fetcher);
      totals.read += r.read;
      totals.inserted += r.inserted;
      totals.updated += r.updated;
      totals.skipped += r.skipped;
      if (r.samples) samples = r.samples;
      covered = day;
      daysCovered++;
      // The checkpoint is "the last day fully stored": it only ever advances over contiguous, completed days.
      await touchRun(run.id, { checkpoint: day, rowsRead: totals.read, rowsInserted: totals.inserted, rowsUpdated: totals.updated, rowsSkipped: totals.skipped, rowsProcessed: totals.inserted + totals.updated });
      log(`  ${day}: ${r.read} read, ${r.inserted} new, ${r.updated} refreshed${r.skipped ? `, ${r.skipped} skipped` : ""}${r.ineligible ? `, ${r.ineligible} not UK (excluded)` : ""}${r.queuedOfficers ? `, ${r.queuedOfficers} queued for officer data` : ""}${r.confirmedEmpty ? " (no registrations at Companies House for this day; confirmed by a control read of the preceding week)" : ""}`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (err instanceof CompaniesHouseBreakerOpenError) error = `Companies House unavailable: ${error}`;
      log(`  ${day}: FAILED - ${error}. Stopping; the next run resumes from ${covered ?? "the same point"}.`);
      break; // never skip a failed day: that would leave a hole the checkpoint then claims is covered
    }
  }

  let status: "success" | "partial" | "failed";
  if (error) status = daysCovered > 0 ? "partial" : "failed";
  else status = totals.read === 0 ? "success" : classifyRun({ rowsRead: totals.read, rowsFailed: 0, rowsSkipped: totals.skipped }).status;
  await finishRun(run.id, status, {
    rowsRead: totals.read,
    rowsInserted: totals.inserted,
    rowsUpdated: totals.updated,
    rowsSkipped: totals.skipped,
    rowsProcessed: totals.inserted + totals.updated,
    checkpoint: covered ?? undefined,
    errorMessage: error,
    errorSamples: samples,
    statsJson: JSON.stringify({ from, to, daysCovered, daysRequested: days.length }),
  });
  return { runId: run.id, status, from, to, coveredThrough: covered, daysCovered, rowsRead: totals.read, rowsInserted: totals.inserted, rowsUpdated: totals.updated, rowsSkipped: totals.skipped, error };
}
