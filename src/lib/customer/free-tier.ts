import { db } from "@/lib/db";
import { visibleCompaniesWhere } from "@/lib/data/scope";

// What a free customer account (role CUSTOMER) may do with company data. Everything here is enforced on the server; the pages
// only display what these functions decide. A customer holds NO permission keys (see resolvePermissions), so none of the
// staff company, report, export or CRM routes open for them - this is the only company access they have.
//
//   Search        : name or exact company number, at least 3 characters, the first 10 matches, a handful of identity fields
//                   (name, number, status, type). No filters, sorting, pages, postcode search or lists.
//                   Rate limited per account (SEARCH_MAX_PER_WINDOW / 15 min, same DB-backed table as sign-in throttling).
//   Opening       : the quota unit is ONE DIFFERENT COMPANY PROFILE OPENED, for the whole life of the account (no reset).
//                   Re-opening a company already opened is free. Search results never count.
//   Profile       : basic public register facts only (no officers, no CRM, no Companies House refresh, no flags).
//   Not available : reports, saved reports, exports, Advanced Search, notes / follow-ups, calendar, staff and admin tools.

export const FREE_SEARCH_MIN_CHARS = 3;
export const FREE_SEARCH_RESULTS = 10;
export const FREE_SEARCH_MAX_PER_WINDOW = 40;
const SEARCH_WINDOW_MS = 15 * 60 * 1000;

// Candidate limit pending Nick's decision. FREE_CUSTOMER_COMPANY_VIEWS overrides it (positive whole number).
export const DEFAULT_FREE_COMPANY_VIEW_LIMIT = 10;
export function freeCompanyViewLimit(): number {
  const n = Number(process.env.FREE_CUSTOMER_COMPANY_VIEWS);
  return Number.isInteger(n) && n > 0 && n <= 1000 ? n : DEFAULT_FREE_COMPANY_VIEW_LIMIT;
}

export interface FreeUsage {
  used: number;
  limit: number;
  remaining: number;
}

export async function getFreeUsage(userId: string): Promise<FreeUsage> {
  const used = await db.customerCompanyView.count({ where: { userId } });
  const limit = freeCompanyViewLimit();
  return { used, limit, remaining: Math.max(0, limit - used) };
}

export async function hasOpened(userId: string, companyId: string): Promise<boolean> {
  return (await db.customerCompanyView.findUnique({ where: { userId_companyId: { userId, companyId } }, select: { id: true } })) !== null;
}

export type OpenResult = { ok: true; alreadyOpened: boolean; usage: FreeUsage } | { ok: false; reason: "limit_reached" | "not_found"; usage: FreeUsage };

// Records that `userId` opened `companyId`, or refuses when the allowance is used up. The User row is locked for the length of
// the transaction, so two parallel requests from one account run one after the other and the second sees the first's row:
// the count can never pass the limit. userId comes from the verified session, never from the request.
export async function openCompany(userId: string, companyId: string): Promise<OpenResult> {
  const limit = freeCompanyViewLimit();
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    const used = await tx.customerCompanyView.count({ where: { userId } });
    const usage = (n: number): FreeUsage => ({ used: n, limit, remaining: Math.max(0, limit - n) });

    const existing = await tx.customerCompanyView.findUnique({ where: { userId_companyId: { userId, companyId } }, select: { id: true } });
    if (existing) return { ok: true as const, alreadyOpened: true, usage: usage(used) };

    // Only a company the customer could have found (real, visible data) can be opened - an id guessed from nowhere cannot.
    const company = await tx.company.findFirst({ where: { AND: [{ id: companyId }, visibleCompaniesWhere()] }, select: { id: true } });
    if (!company) return { ok: false as const, reason: "not_found" as const, usage: usage(used) };
    if (used >= limit) return { ok: false as const, reason: "limit_reached" as const, usage: usage(used) };

    await tx.customerCompanyView.create({ data: { userId, companyId } });
    return { ok: true as const, alreadyOpened: false, usage: usage(used + 1) };
  });
}

export interface FreeSearchRow {
  id: string;
  name: string;
  companyNumber: string;
  status: string;
  type: string;
}

// Normalised search term, or null when it is too short to search.
export function freeSearchTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const term = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  return term.length >= FREE_SEARCH_MIN_CHARS && term.length <= 100 ? term : null;
}

export async function searchForFreeCustomer(term: string): Promise<FreeSearchRow[]> {
  return db.company.findMany({
    where: { AND: [visibleCompaniesWhere(), { OR: [{ name: { contains: term, mode: "insensitive" } }, { companyNumber: term.toUpperCase() }] }] },
    orderBy: { name: "asc" },
    take: FREE_SEARCH_RESULTS,
    select: { id: true, name: true, companyNumber: true, status: true, type: true },
  });
}

// Records the search and says whether this account is over its search allowance. The attempt is recorded first so a burst of
// parallel requests cannot all slip under the limit.
export async function freeSearchBlocked(userId: string): Promise<boolean> {
  const key = `csearch:${userId}`;
  await db.loginAttempt.create({ data: { key } });
  const n = await db.loginAttempt.count({ where: { key, createdAt: { gt: new Date(Date.now() - SEARCH_WINDOW_MS) } } });
  return n > FREE_SEARCH_MAX_PER_WINDOW;
}

// A short, fixed list of real companies shown to free customers before they search ("Sample companies to explore"). Identity
// fields only (the same ones search returns). Listing them never records a view: only the open route does. Active real companies
// in primary-key order are cheap to read (index walk, no sort over the register) and the result is held for ten minutes.
const SAMPLE_SIZE = 6;
const SAMPLE_TTL_MS = 10 * 60_000;
let sampleCache: { rows: FreeSearchRow[]; at: number } | null = null;
export async function getSampleCompanies(): Promise<FreeSearchRow[]> {
  if (sampleCache && Date.now() - sampleCache.at < SAMPLE_TTL_MS) return sampleCache.rows;
  const rows = await db.company.findMany({
    where: { AND: [visibleCompaniesWhere(), { status: "active" }] },
    orderBy: { id: "asc" },
    take: SAMPLE_SIZE,
    select: { id: true, name: true, companyNumber: true, status: true, type: true },
  });
  sampleCache = { rows, at: Date.now() };
  return rows;
}
