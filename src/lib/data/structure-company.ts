import { db } from "@/lib/db";
import { REAL_COMPANIES_WHERE } from "@/lib/data/scope";
import { COMPANY_TYPE_OPTIONS } from "@/lib/filters/fields";
import { formatDateOnly } from "@/lib/data/format";
import { makeLogger } from "@/lib/log";

// The real company the homepage's Corporate structure section shows, and what is known about its ownership.
//
// WHAT EXISTS: a company's own register facts (name, number, status, type, incorporation date) and, where officers were fetched in
// full, how many officers it has. WHAT DOES NOT: DIRECTOR.LTD stores no parent, subsidiary, beneficial-owner or ownership-percentage
// data. There is no table, column or ingest for it (Companies House "persons with significant control" is catalogued as not
// collected, see lib/columns/catalogue.ts), and an officer that is itself a company (a "corporate director") is an appointment, not
// a holding, so it is never turned into a relationship here. verifiedOwnership() is therefore the single place that answers "what
// is the verified structure of this company": today it always says "unavailable", and nothing in this file can produce a name.

const log = makeLogger("structure-company");

export interface StructureCompany {
  id: string;
  companyNumber: string;
  name: string;
  status: string;
  typeLabel: string;
  incorporated: string;
  // Confirmed officer count, or null when officers were never fetched in full (so "unknown" is never shown as 0).
  officers: number | null;
}

export type VerifiedOwnership = { state: "unavailable"; reason: string };

export interface StructureRow {
  id: string;
  companyNumber: string;
  name: string;
  status: string;
  type: string;
  incorporationDate: Date;
  directorCount: number;
  officersCoverage: string;
}

const statusLabel = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, " ") : "Unknown");

export function toStructureCompany(row: StructureRow): StructureCompany {
  return {
    id: row.id,
    companyNumber: row.companyNumber,
    name: row.name,
    status: statusLabel(row.status),
    typeLabel: COMPANY_TYPE_OPTIONS.find((o) => o.value === row.type)?.label ?? "Company",
    incorporated: formatDateOnly(row.incorporationDate),
    officers: row.officersCoverage === "full" ? row.directorCount : null,
  };
}

// The only statement DIRECTOR.LTD can make about a company's parents, subsidiaries and beneficial owners.
export function verifiedOwnership(): VerifiedOwnership {
  return { state: "unavailable", reason: "DIRECTOR.LTD does not hold parent, subsidiary or beneficial ownership data." };
}

// One real, active, non-seed company with confirmed officers, chosen the same way every time (lowest company number), so the page does
// not change from one visit to the next. A failure or an empty register gives null and the section says so instead of inventing one.
let cache: { value: StructureCompany; at: number } | null = null;
export async function getStructureCompany(ttlMs = 30_000): Promise<StructureCompany | null> {
  const now = Date.now();
  if (cache && now - cache.at < ttlMs) return cache.value;
  try {
    const row = await db.company.findFirst({
      where: { AND: [REAL_COMPANIES_WHERE, { status: "active", officersCoverage: "full", directorCount: { gte: 1 } }] },
      orderBy: { companyNumber: "asc" },
      select: { id: true, companyNumber: true, name: true, status: true, type: true, incorporationDate: true, directorCount: true, officersCoverage: true },
    });
    if (!row) return null; // nothing is remembered about an empty result, so a company that is loaded later appears at the next regeneration
    const value = toStructureCompany(row);
    cache = { value, at: now };
    return value;
  } catch (err) {
    log.error("structure company unavailable", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
