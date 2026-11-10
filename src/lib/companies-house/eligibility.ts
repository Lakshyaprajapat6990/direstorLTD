// UK-only eligibility: the ONE rule every company ingestion path applies (monthly bulk file, dissolved / new-registration search
// imports, the filing stream and REST profile enrichment). DIRECTOR.LTD holds UK companies only; the Companies House register also
// carries records that are not UK companies, and none of them may be stored.
//
// How the rule was established (Companies House API + the stored data, 2026-11-07):
//   - API profile `type` is the authority. `registered-overseas-entity` (company numbers OE...), `oversea-company` (FC..., NF...,
//     SF...: overseas companies with a UK presence) and `uk-establishment` (BR...: a branch of an overseas company) are not UK companies.
//   - The monthly bulk file labels FC / NF / SF companies "Other company type", so the stored type is just "other" for them and the
//     type alone cannot catch them there. Their company number prefix does: on the stored data, every FC / NF / SF row of a status
//     that the API reports for `oversea-company` reconciles with the API's own `oversea-company` totals (dissolved 16 = 16; active
//     14,449 stored against 14,394 reported), and sampled profiles of FC / NF / SF numbers all return type `oversea-company`.
//   - Prefixes are NOT used on their own for anything else. `SR` and `NR` look foreign but are Scottish / Northern Ireland royal
//     charters (UK); `GE` is shared by UK economic interest groupings (`ukeig`, UK) and foreign ones (`eeig`), which is why EEIGs are
//     decided from the API profile, not from the number (see EEIG below).
//
// Cross-checks (2026-11-07): of the 44,755 rows in the October 2026 bulk file that this rule excludes, 44,207 name a foreign
// CountryOfOrigin; and every FC / NF / SF profile read from the API (546 of them) is type `oversea-company`. The exception is
// NF: 260 of them are companies incorporated in Great Britain that registered a Northern Ireland establishment. Those 260 (and 13
// FC / SF records with no origin on their profile) were NOT deleted: they stay as ambiguous, are no longer refreshed by the bulk
// file, and are listed in tmp-ingest/backup/keep-ambiguous-273.txt.
//
// EEIG: Companies House type `eeig` is a European grouping with its official address abroad and only a UK establishment; type `ukeig`
// is a UK grouping. The bulk file labels both "EEIG", so a stored `eeig` row is ambiguous until its profile is read. Such rows are
// neither imported as eligible nor deleted here: see UK_AMBIGUOUS_TYPES.

// Companies House company types that are not UK companies.
export const NON_UK_COMPANY_TYPES: readonly string[] = ["registered-overseas-entity", "oversea-company", "uk-establishment"];

// Company-number prefixes Companies House issues to overseas entities (OE), overseas companies (FC England & Wales / UK-wide,
// NF Northern Ireland, SF Scotland) and UK establishments of overseas companies (BR). Verified against the API, see above.
export const NON_UK_NUMBER_PREFIXES: readonly string[] = ["OE", "FC", "NF", "SF", "BR"];

// Not decidable from the bulk file alone (see EEIG above). Kept, never silently classified.
export const UK_AMBIGUOUS_TYPES: readonly string[] = ["eeig"];

const NON_UK_TYPE_SET = new Set(NON_UK_COMPANY_TYPES);
const NON_UK_NUMBER = new RegExp(`^(${NON_UK_NUMBER_PREFIXES.join("|")})\\d+$`);

export interface EligibilityInput {
  companyNumber?: string | null;
  type?: string | null;
}

// True for a record that is NOT a UK company and must never be stored.
export function isNonUkCompany(c: EligibilityInput): boolean {
  if (c.type && NON_UK_TYPE_SET.has(c.type)) return true;
  const n = (c.companyNumber ?? "").trim().toUpperCase();
  return NON_UK_NUMBER.test(n);
}

export const isUkEligible = (c: EligibilityInput): boolean => !isNonUkCompany(c);

export const NON_UK_REASON = "not a UK company (overseas entity, overseas company or UK establishment)";

// Postgres expression for the same rule over "Company" rows, for read-only audits and the one-off cleanup. The number test uses
// ranges, so it can use the unique index on companyNumber.
export const NON_UK_SQL_PREDICATE =
  `("type" IN (${NON_UK_COMPANY_TYPES.map((t) => `'${t}'`).join(", ")}) OR ` +
  NON_UK_NUMBER_PREFIXES.map((p) => `("companyNumber" >= '${p}' AND "companyNumber" < '${p.slice(0, -1)}${String.fromCharCode(p.charCodeAt(p.length - 1) + 1)}')`).join(" OR ") +
  ")";
