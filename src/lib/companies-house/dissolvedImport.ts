import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { chRestGet, CompaniesHouseBreakerOpenError, CompaniesHouseNotFoundError, CompaniesHouseRateLimitError } from "./client";
import { parseChDate } from "./csv/dates";
import { normalisePostcode } from "./csv/mapping";
import { isNonUkCompany, NON_UK_REASON } from "./eligibility";
import { classifyRun, ErrorSampler, finishRun, startRun, touchRun } from "@/lib/jobs/runs";

// Dissolved / historical-company import.
//
// Why this exists: the monthly "Free Company Data Product" (BasicCompanyDataAsOneFile) is, in Companies House's own words,
// a snapshot of LIVE companies. It holds no dissolved company at all, so the bulk file can never fill that gap. The only
// official, documented, bulk-capable source for the rest of the register is the Public Data API Advanced Search
// (/advanced-search/companies), which can filter by company_status and incorporation date.
//
// Strategy (resumable, idempotent, never skips silently):
//   - the register is walked in ascending incorporation-date windows (pre-1900 in 50-year spans, 1900-1989 yearly,
//     1990-2009 monthly, 2010+ daily). The API returns at most 5,000 rows per request and refuses start_index paging
//     beyond that, so a window whose `hits` exceeds what one response carried is split in half and both halves are
//     fetched again, down to a single day; a single day that is still too large is split by dissolution date.
//     A window that cannot be read completely is recorded as failed and the run is "partial": coverage is never claimed.
//   - the checkpoint is the last top-level window fully stored; a resumed run continues after it.
//   - rows are written with one INSERT .. ON CONFLICT per response. New companies are inserted. An existing company is
//     only touched to bring its status / dissolution date in line with the register (a company that was live in the
//     monthly snapshot and dissolved since); its name, address, SIC codes, accounts dates, officers and CRM data are
//     never overwritten, so a repeat run changes nothing.

const SEARCH_PATH = "/advanced-search/companies";
const PAGE_SIZE = 5000;
const DAY_MS = 86_400_000;
const EARLIEST = "1600-01-01";
// Companies House marks a company dissolved ahead of its cessation date (the stored data shows dissolution dates days in the future), so a
// "dissolved since" window must reach beyond today or it would miss exactly the companies that were just struck off.
const DISSOLVED_LOOKAHEAD_DAYS = 120;

// A company that has reached one of these end states is no longer live. When the register says so, an already stored row that still
// shows as live is brought in line (status / dissolution date only). Live statuses (liquidation, administration, ...) are refreshed
// by the monthly bulk file, not here.
export const TERMINAL_STATUSES = ["dissolved", "converted-closed", "removed", "closed"] as const;
const TERMINAL_SQL = Prisma.raw(TERMINAL_STATUSES.map((s) => `'${s}'`).join(", "));

export interface Window {
  from: string; // incorporation date, inclusive
  to: string;
  dissolvedFrom?: string; // only used to split a single over-full day
  dissolvedTo?: string;
}

export const addDays = (day: string, n: number) => new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
const validDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
const daysApart = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");

// Pure: the ordered top-level windows covering [from, to].
export function planWindows(from: string, to: string): Window[] {
  const out: Window[] = [];
  const push = (a: string, b: string) => {
    const f = a < from ? from : a;
    const t = b > to ? to : b;
    if (f <= t) out.push({ from: f, to: t });
  };
  for (let y = 1600; y < 1900; y += 50) push(`${y}-01-01`, `${y + 49}-12-31`);
  for (let y = 1900; y < 1990; y++) push(`${y}-01-01`, `${y}-12-31`);
  for (let y = 1990; y < 2010; y++) for (let m = 1; m <= 12; m++) push(`${y}-${pad(m)}-01`, lastOfMonth(y, m));
  const start = from > "2010-01-01" ? from : "2010-01-01";
  for (let d = start; d <= to; d = addDays(d, 1)) if (d >= "2010-01-01") push(d, d);
  return out;
}

// Pure: split a window that is too large. Returns null when it cannot be split further.
export function splitWindow(w: Window): [Window, Window] | null {
  if (w.from < w.to) {
    const mid = addDays(w.from, Math.floor(daysApart(w.from, w.to) / 2));
    return [{ ...w, to: mid }, { ...w, from: addDays(mid, 1) }];
  }
  // One incorporation day: split on the dissolution date instead.
  const lo = w.dissolvedFrom ?? (w.from > "1900-01-01" ? w.from : "1900-01-01");
  const hi = w.dissolvedTo ?? addDays(new Date().toISOString().slice(0, 10), 1);
  if (lo >= hi) return null;
  const mid = addDays(lo, Math.floor(daysApart(lo, hi) / 2));
  return [{ ...w, dissolvedFrom: lo, dissolvedTo: mid }, { ...w, dissolvedFrom: addDays(mid, 1), dissolvedTo: hi }];
}

interface SearchItem {
  company_number: string;
  company_name: string;
  company_status: string;
  company_type: string;
  date_of_creation?: string;
  date_of_cessation?: string;
  sic_codes?: string[];
  registered_office_address?: { address_line_1?: string; address_line_2?: string; locality?: string; region?: string; postal_code?: string };
}
interface SearchResponse {
  items?: SearchItem[];
  hits?: number;
}

export interface MappedRow {
  companyNumber: string;
  name: string;
  status: string;
  type: string;
  incorporationDate: string;
  dissolutionDate: string | null;
  sicCodes: string;
  address1: string;
  address2: string | null;
  city: string;
  postcode: string;
  county: string | null;
}

// Pure: a search hit as a row, or the reason it cannot be stored.
export function mapItem(item: SearchItem): { ok: true; row: MappedRow } | { ok: false; reason: string; companyNumber?: string; ineligible?: true } {
  const inc = parseChDate(item.date_of_creation);
  if (!item.company_number) return { ok: false, reason: "missing company_number" };
  const companyNumber = item.company_number.trim().toUpperCase();
  // UK companies only (see eligibility.ts): overseas entities, overseas companies and UK establishments are left out, not rejected.
  if (isNonUkCompany({ companyNumber, type: item.company_type })) return { ok: false, reason: NON_UK_REASON, companyNumber, ineligible: true };
  if (!inc) return { ok: false, reason: "missing/invalid date_of_creation", companyNumber };
  if (!item.company_name || !item.company_status || !item.company_type) return { ok: false, reason: "missing required field", companyNumber };
  const a = item.registered_office_address;
  const diss = parseChDate(item.date_of_cessation);
  return {
    ok: true,
    row: {
      companyNumber,
      name: item.company_name,
      status: item.company_status,
      type: item.company_type,
      incorporationDate: inc.toISOString().slice(0, 10),
      dissolutionDate: diss ? diss.toISOString().slice(0, 10) : null,
      sicCodes: (item.sic_codes ?? []).join(","),
      address1: a?.address_line_1 ?? "",
      address2: a?.address_line_2 ?? null,
      city: a?.locality ?? "",
      postcode: normalisePostcode(a?.postal_code ?? ""),
      county: a?.region ?? null,
    },
  };
}

const COLS = [
  "id", "companyNumber", "name", "status", "type", "incorporationDate", "dissolutionDate", "sicCodes", "registeredAddress1",
  "registeredAddress2", "registeredCity", "registeredPostcode", "registeredCounty", "source", "chLastFetchedAt", "createdAt", "updatedAt",
];

function tuple(r: MappedRow, now: string): Prisma.Sql {
  return Prisma.sql`(${randomUUID()}, ${r.companyNumber}, ${r.name}, ${r.status}, ${r.type}, ${r.incorporationDate}::date, ${r.dissolutionDate}::date,
    ${r.sicCodes}, ${r.address1}, ${r.address2}, ${r.city}, ${r.postcode}, ${r.county}, 'advanced_search',
    CAST(${now} AS timestamp), CAST(${now} AS timestamp), CAST(${now} AS timestamp))`;
}

// Inserts new companies; for an existing one only reconciles status / dissolution date, and only when they really differ
// (so an unchanged row is not rewritten). Seed rows are never touched. Returns inserted / updated counts.
export async function upsertRows(rows: MappedRow[], reconcileLive = false): Promise<{ inserted: number; updated: number }> {
  // Postgres allows 65,535 bind parameters per statement; a row binds 13.
  if (rows.length > 2000) {
    const total = { inserted: 0, updated: 0 };
    for (let i = 0; i < rows.length; i += 2000) {
      const r = await upsertRows(rows.slice(i, i + 2000), reconcileLive);
      total.inserted += r.inserted;
      total.updated += r.updated;
    }
    return total;
  }
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const now = new Date().toISOString();
  const out = await db.$queryRaw<{ inserted: boolean }[]>(Prisma.sql`
    INSERT INTO "Company" (${Prisma.join(COLS.map((c) => Prisma.raw(`"${c}"`)))})
    VALUES ${Prisma.join(rows.map((r) => tuple(r, now)))}
    ON CONFLICT ("companyNumber") DO UPDATE SET
      "status" = EXCLUDED."status",
      "statusDetail" = CASE WHEN EXCLUDED."status" IN (${TERMINAL_SQL}) THEN NULL ELSE "Company"."statusDetail" END,
      "dissolutionDate" = EXCLUDED."dissolutionDate",
      "accountsOverdue" = CASE WHEN EXCLUDED."status" IN (${TERMINAL_SQL}) THEN false ELSE "Company"."accountsOverdue" END,
      "confirmationOverdue" = CASE WHEN EXCLUDED."status" IN (${TERMINAL_SQL}) THEN false ELSE "Company"."confirmationOverdue" END,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "Company"."source" <> 'seed'
      AND (EXCLUDED."status" IN (${TERMINAL_SQL}) OR ${reconcileLive}::boolean)
      AND ("Company"."status" IS DISTINCT FROM EXCLUDED."status" OR "Company"."dissolutionDate" IS DISTINCT FROM EXCLUDED."dissolutionDate")
    RETURNING (xmax = 0) AS inserted`);
  const inserted = out.filter((r) => r.inserted).length;
  return { inserted, updated: out.length - inserted };
}

// Read-only prediction for a dry run.
async function predict(rows: MappedRow[], reconcileLive = false): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const have = await db.company.findMany({
    where: { companyNumber: { in: rows.map((r) => r.companyNumber) } },
    select: { companyNumber: true, status: true, dissolutionDate: true, source: true },
  });
  const m = new Map(have.map((h) => [h.companyNumber, h]));
  let inserted = 0, updated = 0;
  for (const r of rows) {
    const h = m.get(r.companyNumber);
    if (!h) inserted++;
    else if (h.source !== "seed" && (reconcileLive || (TERMINAL_STATUSES as readonly string[]).includes(r.status)) && (h.status !== r.status || (h.dissolutionDate?.toISOString().slice(0, 10) ?? null) !== r.dissolutionDate)) updated++;
  }
  return { inserted, updated };
}

export interface DissolvedImportOptions {
  status?: string; // company_status filter (default "dissolved")
  from?: string; // YYYY-MM-DD incorporation lower bound
  to?: string;
  resumeRunId?: string;
  dryRun?: boolean;
  maxRequests?: number; // stop (resumably) after this many API requests
  // Adaptive mode: ONE top-level window [from, to] that is split in half only where Companies House reports more matches than a
  // response can carry. Far fewer requests than the full date walk when the expected result set is small (a status with tens of
  // thousands of companies, or the companies dissolved since a date). Coverage is still proven by the same hits == read check.
  adaptive?: boolean;
  // Also bring an already stored company in line when the register shows it in a LIVE non-active status (liquidation, administration,
  // receivership, ...). Off by default: the monthly bulk file normally refreshes live statuses.
  reconcileLive?: boolean;
  dissolvedSince?: string; // adaptive only: restrict to companies dissolved on or after this day (YYYY-MM-DD)
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface DissolvedImportResult {
  runId: string;
  status: string;
  dryRun: boolean;
  requests: number;
  windowsCompleted: number;
  windowsTotal: number;
  coveredThrough: string | null;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  rowsDuplicateInResponse: number;
  rowsRejected: number;
  rowsIneligible: number; // not UK companies: read from the register but deliberately not stored
  failedWindows: string[];
  sourceHitsSum: number; // sum of `hits` over the leaf windows actually read: must equal rowsRead
  error: string | null;
}

class StopRun extends Error {}

export async function importDissolved(options: DissolvedImportOptions = {}): Promise<DissolvedImportResult> {
  const log = options.log ?? (() => {});
  const status = options.status ?? "dissolved";
  const dry = options.dryRun === true;
  const today = new Date().toISOString().slice(0, 10);
  const from = options.from ?? EARLIEST;
  const to = options.to ?? today;
  for (const d of [from, to]) if (!validDay(d)) throw new Error(`Invalid date "${d}" (use YYYY-MM-DD)`);

  if (options.dissolvedSince !== undefined && (!options.adaptive || !validDay(options.dissolvedSince))) throw new Error("dissolvedSince needs adaptive mode and a YYYY-MM-DD day");
  const inputName = `${status}:${from}..${to}${options.adaptive ? "|adaptive" : ""}${options.dissolvedSince ? `|dissolved>=${options.dissolvedSince}` : ""}`;
  let resumeAfter: string | null = null;
  let run: { id: string } = { id: "dry-run" };
  let carried = { read: 0, inserted: 0, updated: 0, unchanged: 0, dup: 0, rejected: 0, ineligible: 0, requests: 0, hits: 0, windows: 0, failed: [] as string[] };
  if (!dry) {
    if (options.resumeRunId) {
      const prior = await db.ingestionRun.findUniqueOrThrow({ where: { id: options.resumeRunId } });
      if (prior.kind !== "advanced_search" || prior.inputName !== inputName) throw new Error(`Run ${prior.id} is not a ${inputName} dissolved import`);
      if (prior.status === "running") throw new Error(`Run ${prior.id} is still marked running; wait for it or let it go stale first`);
      resumeAfter = prior.checkpoint;
      const s = prior.statsJson ? JSON.parse(prior.statsJson) : {};
      carried = { ...carried, ...s.totals, failed: s.totals?.failed ?? [] };
      await db.ingestionRun.update({ where: { id: prior.id }, data: { status: "running", finishedAt: null, errorMessage: null, heartbeatAt: new Date() } });
      run = prior;
      log(`Resuming run ${prior.id} after window ending ${resumeAfter}`);
    } else {
      run = await startRun("advanced_search", { inputName });
    }
  }

  const windows: Window[] = options.adaptive
    ? [{ from, to, ...(options.dissolvedSince ? { dissolvedFrom: options.dissolvedSince, dissolvedTo: addDays(today, DISSOLVED_LOOKAHEAD_DAYS) } : {}) }]
    : planWindows(from, to);
  const t = { ...carried };
  const samples = new ErrorSampler(25);
  let lastDone: string | null = resumeAfter;
  let error: string | null = null;
  const startedAt = Date.now();

  async function fetchWindow(w: Window): Promise<SearchResponse> {
    if (options.maxRequests !== undefined && t.requests >= options.maxRequests) throw new StopRun();
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw new StopRun();
      try {
        t.requests++;
        return await chRestGet<SearchResponse>(SEARCH_PATH, {
          params: {
            company_status: status,
            incorporated_from: w.from,
            incorporated_to: w.to,
            dissolved_from: w.dissolvedFrom,
            dissolved_to: w.dissolvedTo,
            size: PAGE_SIZE,
            start_index: 0,
          },
          quotaClass: "backfill",
          maxQuotaWaitMs: 5 * 60_000,
          timeoutMs: 120_000,
        });
      } catch (err) {
        if (err instanceof CompaniesHouseBreakerOpenError) throw err;
        if (err instanceof CompaniesHouseNotFoundError) return { items: [], hits: 0 }; // the API answers 404 for a search with no matches
        const retriable = err instanceof CompaniesHouseRateLimitError || (err instanceof Error && /(^|\D)(5\d\d)(\D|$)|fetch failed|aborted|timeout/i.test(err.message));
        if (retriable && attempt < 5) {
          await new Promise((r) => setTimeout(r, err instanceof CompaniesHouseRateLimitError ? Math.max(1000, err.retryAfterMs) : 2000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  const label = (w: Window) => `${w.from}..${w.to}${w.dissolvedFrom ? ` dissolved ${w.dissolvedFrom}..${w.dissolvedTo}` : ""}`;

  // Reads one window completely (splitting when needed). Throws only for infrastructure failures.
  async function readWindow(w: Window): Promise<void> {
    // Proof of life for the run row: a single adaptive window can wait minutes for shared quota between top-level checkpoints, and a
    // run with no heartbeat is closed as dead by the stale-run reconciliation.
    if (!dry) await touchRun(run.id).catch(() => {});
    if (options.adaptive && t.requests > 0 && t.requests % 100 === 0) {
      log(`  adaptive progress: ${t.requests} requests, ${t.read.toLocaleString()} read, ${t.inserted.toLocaleString()} new, ${t.updated.toLocaleString()} reconciled, ${t.ineligible} not UK, ${t.failed.length} failed windows`);
    }
    const res = await fetchWindow(w);
    const items = res.items ?? [];
    const hits = res.hits ?? items.length;
    if (hits > items.length) {
      const halves = splitWindow(w);
      if (!halves) {
        t.failed.push(`${label(w)} (${hits} matches, ${items.length} readable)`);
        samples.add(0, `window cannot be split further: ${hits} matches but ${items.length} readable`, undefined);
        // Still store what we can read: it is correct data, just not provably complete.
        await store(items);
        return;
      }
      for (const h of halves) await readWindow(h);
      return;
    }
    t.hits += hits;
    await store(items);
  }

  async function store(items: SearchItem[]) {
    const byNumber = new Map<string, MappedRow>();
    for (const item of items) {
      t.read++;
      const m = mapItem(item);
      if (!m.ok && m.ineligible) {
        t.ineligible++; // counted, never stored, and not a rejection
        continue;
      }
      if (!m.ok) {
        t.rejected++;
        samples.add(t.read, m.reason, m.companyNumber);
        continue;
      }
      if (byNumber.has(m.row.companyNumber)) t.dup++;
      byNumber.set(m.row.companyNumber, m.row);
    }
    const rows = [...byNumber.values()];
    const r = dry ? await predict(rows, options.reconcileLive === true) : await upsertRows(rows, options.reconcileLive === true);
    t.inserted += r.inserted;
    t.updated += r.updated;
    t.unchanged += rows.length - r.inserted - r.updated;
  }

  const persist = (checkpoint: string | null) =>
    dry
      ? Promise.resolve()
      : touchRun(run.id, {
          checkpoint,
          rowsRead: t.read,
          rowsInserted: t.inserted,
          rowsUpdated: t.updated,
          rowsSkipped: t.rejected + t.dup,
          rowsFailed: t.failed.length,
          rowsProcessed: t.inserted + t.updated,
          errorSamples: samples.toJson(),
          statsJson: JSON.stringify({ totals: t, from, to, status, windowsTotal: windows.length }),
        });

  try {
    for (const w of windows) {
      if (resumeAfter && w.to <= resumeAfter) continue;
      try {
        await readWindow(w);
      } catch (err) {
        if (err instanceof StopRun) throw err;
        error = err instanceof Error ? err.message : String(err);
        log(`  window ${label(w)} FAILED - ${error}. Stopping; resume continues after ${lastDone ?? "the start"}.`);
        break; // never skip a failed window: the checkpoint would then claim a hole is covered
      }
      lastDone = w.to;
      t.windows++;
      await persist(lastDone);
      if (t.windows % 25 === 0 || w.from.slice(0, 4) !== w.to.slice(0, 4)) {
        const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
        log(`  through ${w.to}: ${t.read.toLocaleString()} read, ${t.inserted.toLocaleString()} new, ${t.updated.toLocaleString()} reconciled, ${t.unchanged.toLocaleString()} unchanged, ${t.rejected} rejected, ${t.failed.length} failed windows, ${t.requests} requests, ${mins} min`);
      }
    }
  } catch (err) {
    if (!(err instanceof StopRun)) error = err instanceof Error ? err.message : String(err);
    else error = "stopped (request limit or interrupt); resumable";
  }

  let finalStatus: "success" | "partial" | "failed";
  const complete = !error && t.failed.length === 0;
  if (error) finalStatus = t.windows > 0 ? "partial" : "failed";
  else finalStatus = t.failed.length ? "partial" : t.read === 0 ? "success" : classifyRun({ rowsRead: t.read, rowsFailed: 0, rowsSkipped: t.rejected }).status;
  if (!dry) {
    await finishRun(run.id, finalStatus, {
      checkpoint: lastDone ?? undefined,
      rowsRead: t.read,
      rowsInserted: t.inserted,
      rowsUpdated: t.updated,
      rowsSkipped: t.rejected + t.dup,
      rowsFailed: t.failed.length,
      rowsProcessed: t.inserted + t.updated,
      errorSamples: samples.toJson(),
      errorMessage: error ?? (t.failed.length ? `${t.failed.length} window(s) could not be read completely` : null),
      statsJson: JSON.stringify({ totals: t, from, to, status, windowsTotal: windows.length, complete }),
    });
  }
  return {
    runId: run.id,
    status: finalStatus,
    dryRun: dry,
    requests: t.requests,
    windowsCompleted: t.windows + (resumeAfter ? windows.filter((w) => w.to <= resumeAfter!).length - 0 : 0),
    windowsTotal: windows.length,
    coveredThrough: lastDone,
    rowsRead: t.read,
    rowsInserted: t.inserted,
    rowsUpdated: t.updated,
    rowsUnchanged: t.unchanged,
    rowsDuplicateInResponse: t.dup,
    rowsRejected: t.rejected,
    rowsIneligible: t.ineligible,
    failedWindows: t.failed,
    sourceHitsSum: t.hits,
    error,
  };
}
