import { emptyFilterGroup, type FilterGroupNode } from "@/lib/filters/types";
import { setBool, setChecked, setRange, setText } from "@/lib/filters/criteria";
import { COMPANY_TYPE_OPTIONS } from "@/lib/filters/fields";

// The homepage search widget and the /companies deep link share this one definition, so a search typed on the public homepage
// becomes exactly the filters the signed-in UK Companies page already understands (same filter registry, same compiler, same
// API). Nothing here queries anything: it only parses, validates and describes a search.
//
// What each mode really searches (all against the real Company table, UK register only):
//   company   - name, company number or postcode text (the existing search box)       [+ company type]
//   filings   - one filing position: DS01 strike-off, late accounts, late confirmation statement, dormant [+ text, type]
//   directors - confirmed director data: a single director, or two or more              [+ text, type]
//   sic       - a UK SIC code (2 to 5 digits, matched anywhere in the company's SIC codes) [+ type]
// There is NO search by a director's personal name: the filter registry has no such field, and adding one is a backend feature outside
// this task. The Directors tab therefore filters on the confirmed director counts the platform really holds.

export const SEARCH_MODES = ["company", "filings", "directors", "sic"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

// The data is the UK Companies House register only, so this is the one honest jurisdiction. It is a real control (and a real URL
// parameter) so a second register can be added later without reshaping the widget.
export const COUNTRY_OPTIONS = [{ value: "gb", label: "United Kingdom" }] as const;

export const TYPE_OPTIONS = COMPANY_TYPE_OPTIONS;

export const FILING_OPTIONS = [
  { value: "ds01", label: "DS01 strike-off filed", field: "hasDS01" },
  { value: "late-accounts", label: "Late accounts", field: "accountsOverdue" },
  { value: "late-confirmation", label: "Late confirmation statement", field: "confirmationOverdue" },
  { value: "dormant", label: "Dormant companies", field: "dormant" },
] as const;

export const DIRECTOR_OPTIONS = [
  { value: "single", label: "Single director" },
  { value: "multiple", label: "Two or more directors" },
] as const;

export const MAX_QUERY_LENGTH = 100;
export const MIN_QUERY_LENGTH = 2;

export interface HomeSearch {
  mode: SearchMode;
  q: string; // company / filings / directors: the text box. Empty for sic.
  sic: string; // sic mode: the code
  type: string; // a COMPANY_TYPE_OPTIONS value or ""
  filing: string; // a FILING_OPTIONS value or ""
  directors: string; // a DIRECTOR_OPTIONS value or ""
  country: string; // always "gb" today
}

type Raw = Record<string, string | string[] | undefined> | URLSearchParams;
const first = (raw: Raw, key: string): string => {
  const v = raw instanceof URLSearchParams ? raw.get(key) : raw[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};
const oneOf = <T extends { value: string }>(options: readonly T[], value: string): string => (options.some((o) => o.value === value) ? value : "");

// Free text is normalised once: Unicode NFC, control characters dropped, whitespace collapsed, trimmed, length capped.
export function cleanQuery(raw: string): string {
  let out = "";
  for (const ch of raw.normalize("NFC")) {
    const c = ch.charCodeAt(0);
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

// Reads untrusted parameters (URL or form) into a clean search. Unknown values are dropped, never trusted.
export function parseHomeSearch(raw: Raw): HomeSearch {
  const mode = (SEARCH_MODES as readonly string[]).includes(first(raw, "mode")) ? (first(raw, "mode") as SearchMode) : "company";
  const sicRaw = first(raw, "sic").replace(/\s+/g, "");
  return {
    mode,
    q: mode === "sic" ? "" : cleanQuery(first(raw, "q")),
    sic: mode === "sic" ? sicRaw.slice(0, 12) : /^\d{2,5}$/.test(sicRaw) ? sicRaw : "",
    type: oneOf(TYPE_OPTIONS, first(raw, "type")),
    filing: mode === "filings" || mode === "company" ? oneOf(FILING_OPTIONS, first(raw, "filing")) : "",
    directors: mode === "directors" || mode === "company" ? oneOf(DIRECTOR_OPTIONS, first(raw, "directors")) : "",
    country: "gb",
  };
}

// The message to show before sending, or null when the search is acceptable.
export function validateHomeSearch(s: HomeSearch): string | null {
  const text = s.q.length >= MIN_QUERY_LENGTH;
  switch (s.mode) {
    case "sic":
      return /^\d{2,5}$/.test(s.sic) ? null : "Enter a SIC code of 2 to 5 digits, for example 62012.";
    case "filings":
      return s.filing || text ? null : "Choose a filing position, or enter a company name, number or postcode.";
    case "directors":
      return s.directors || text ? null : "Choose a director position, or enter a company name, number or postcode.";
    default:
      return text || s.type ? null : `Enter at least ${MIN_QUERY_LENGTH} characters of a company name, number or postcode, or choose a company type.`;
  }
}

// The same search as filters on the existing UK Companies page. Built with the page's own criteria helpers, so its Advanced
// Search panel shows them as ordinary, editable criteria.
export function buildHomeFilter(s: HomeSearch): FilterGroupNode {
  let root = emptyFilterGroup();
  if (s.type) root = setChecked(root, "type", [s.type]);
  if (/^\d{2,5}$/.test(s.sic)) root = setText(root, "sicCodes", "contains", s.sic);
  const filing = FILING_OPTIONS.find((o) => o.value === s.filing);
  if (filing) root = setBool(root, filing.field, "yes");
  if (s.directors === "single") root = setBool(root, "singleDirector", "yes");
  if (s.directors === "multiple") root = setRange(root, "directorCount", "2", "");
  return root;
}

// The URL the widget sends the visitor to: the existing /companies page, with only the parameters that carry a choice.
export function homeSearchHref(s: HomeSearch): string {
  const p = new URLSearchParams();
  p.set("mode", s.mode);
  if (s.q) p.set("q", s.q);
  if (s.sic) p.set("sic", s.sic);
  if (s.type) p.set("type", s.type);
  if (s.filing) p.set("filing", s.filing);
  if (s.directors) p.set("directors", s.directors);
  return `/companies?${p.toString()}`;
}

// A free account's own search (name or number only; see lib/customer/free-tier.ts). Filing, director and SIC searches are
// not part of a free account, so those carry a flag that lets the page say so honestly.
export function customerSearchHref(s: HomeSearch): string {
  const p = new URLSearchParams();
  if (s.mode === "company" && s.q) p.set("q", s.q);
  if (s.mode !== "company" || s.type || s.filing || s.directors) p.set("advanced", "1");
  const qs = p.toString();
  return qs ? `/find-companies?${qs}` : "/find-companies";
}

// A return address from the sign-in page: ONLY a path on this same site. Anything that could leave the site (another host, a
// protocol-relative //host, backslash tricks, control characters, an absolute URL) is refused, so ?next= cannot be used as an open
// redirect. Returns the safe path (with its query string) or null.
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2000) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  try {
    const u = new URL(raw, "http://site.invalid");
    if (u.origin !== "http://site.invalid") return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}
