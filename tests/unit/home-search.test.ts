import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COUNTRY_OPTIONS, DIRECTOR_OPTIONS, FILING_OPTIONS, MAX_QUERY_LENGTH, TYPE_OPTIONS, buildHomeFilter, cleanQuery, customerSearchHref, homeSearchHref, parseHomeSearch, safeNextPath, validateHomeSearch, type HomeSearch } from "../../src/lib/home-search";
import { compileFilterToWhere } from "../../src/lib/filters/compile";
import { parseFilter } from "../../src/lib/filters/validate";
import { COMPANY_FILTER_FIELDS } from "../../src/lib/filters/fields";

const root = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const P = (o: Record<string, string>) => new URLSearchParams(o);
const base: HomeSearch = { mode: "company", q: "", sic: "", type: "", filing: "", directors: "", country: "gb" };

// ---- parsing -----------------------------------------------------------------------------------------------------------------
test("every mode parses; unknown modes and values are dropped, never trusted", () => {
  for (const mode of ["company", "filings", "directors", "sic"]) assert.equal(parseHomeSearch(P({ mode })).mode, mode);
  assert.equal(parseHomeSearch(P({ mode: "admin" })).mode, "company");
  assert.equal(parseHomeSearch(P({})).mode, "company");
  assert.equal(parseHomeSearch(P({ type: "not-a-type" })).type, "");
  assert.equal(parseHomeSearch(P({ type: "ltd" })).type, "ltd");
  assert.equal(parseHomeSearch(P({ mode: "filings", filing: "evil" })).filing, "");
  assert.equal(parseHomeSearch(P({ mode: "filings", filing: "ds01" })).filing, "ds01");
  assert.equal(parseHomeSearch(P({ mode: "directors", directors: "single" })).directors, "single");
  assert.equal(parseHomeSearch(P({ mode: "directors", directors: "<script>" })).directors, "");
  assert.equal(parseHomeSearch(P({ country: "fr" })).country, "gb", "only the UK register exists, whatever is sent");
  assert.deepEqual(parseHomeSearch({ q: ["first", "second"], mode: ["sic", "company"] }).mode, "sic", "an array parameter uses its first value");
});

test("free text is cleaned: whitespace collapsed, control characters removed, length capped", () => {
  assert.equal(cleanQuery("  Acme   Trading\tLtd \n"), "Acme Trading Ltd");
  assert.equal(cleanQuery(`a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`), "a b c");
  assert.equal(cleanQuery("x".repeat(500)).length, MAX_QUERY_LENGTH);
  assert.equal(cleanQuery("Café"), "Café", "normalised to NFC");
  assert.equal(parseHomeSearch(P({ q: "  tesco  " })).q, "tesco");
});

test("the SIC tab keeps only a 2 to 5 digit code and the other tabs never carry one", () => {
  assert.equal(parseHomeSearch(P({ mode: "sic", sic: " 62 012 " })).sic, "62012");
  assert.equal(parseHomeSearch(P({ mode: "sic", sic: "62012" })).q, "");
  assert.equal(parseHomeSearch(P({ mode: "company", sic: "62012" })).sic, "62012", "a SIC filter may accompany a company search");
  assert.equal(parseHomeSearch(P({ mode: "company", sic: "abc" })).sic, "");
  assert.equal(parseHomeSearch(P({ mode: "company", sic: "123456" })).sic, "", "six digits is not a SIC code");
});

// ---- validation: what the widget refuses before sending ---------------------------------------------------------------------
test("each mode refuses what it cannot search, with a message that says what to do", () => {
  assert.match(validateHomeSearch({ ...base })!, /at least 2 characters/);
  assert.match(validateHomeSearch({ ...base, q: "a" })!, /at least 2 characters/);
  assert.equal(validateHomeSearch({ ...base, q: "ab" }), null);
  assert.equal(validateHomeSearch({ ...base, type: "ltd" }), null, "choosing a company type is enough");
  assert.match(validateHomeSearch({ ...base, mode: "sic" })!, /2 to 5 digits/);
  assert.match(validateHomeSearch({ ...base, mode: "sic", sic: "6" })!, /2 to 5 digits/);
  assert.match(validateHomeSearch({ ...base, mode: "sic", sic: "ab123" })!, /2 to 5 digits/);
  assert.equal(validateHomeSearch({ ...base, mode: "sic", sic: "62" }), null);
  assert.equal(validateHomeSearch({ ...base, mode: "sic", sic: "62012" }), null);
  assert.match(validateHomeSearch({ ...base, mode: "filings" })!, /filing position/);
  assert.equal(validateHomeSearch({ ...base, mode: "filings", filing: "ds01" }), null);
  assert.equal(validateHomeSearch({ ...base, mode: "filings", q: "acme" }), null);
  assert.match(validateHomeSearch({ ...base, mode: "directors" })!, /director position/);
  assert.equal(validateHomeSearch({ ...base, mode: "directors", directors: "multiple" }), null);
});

// ---- the filters really are the existing registry's, compiled by the existing compiler -----------------------------------------
const fieldKeys = new Set(COMPANY_FILTER_FIELDS.map((f) => f.key));
const rulesOf = (s: HomeSearch) => buildHomeFilter(s).children.flatMap((c) => (c.kind === "rule" ? [c] : c.children.filter((x) => x.kind === "rule")));

test("every mode builds filters on real registry fields, accepted by the existing validator and compiler", () => {
  const cases: [string, HomeSearch, string, string][] = [
    ["company type", { ...base, type: "llp" }, "type", "equals"],
    ["SIC code", { ...base, mode: "sic", sic: "62012" }, "sicCodes", "contains"],
    ["DS01", { ...base, mode: "filings", filing: "ds01" }, "hasDS01", "isTrue"],
    ["late accounts", { ...base, mode: "filings", filing: "late-accounts" }, "accountsOverdue", "isTrue"],
    ["late confirmation", { ...base, mode: "filings", filing: "late-confirmation" }, "confirmationOverdue", "isTrue"],
    ["dormant", { ...base, mode: "filings", filing: "dormant" }, "dormant", "isTrue"],
    ["single director", { ...base, mode: "directors", directors: "single" }, "singleDirector", "isTrue"],
    ["two or more directors", { ...base, mode: "directors", directors: "multiple" }, "directorCount", "gte"],
  ];
  for (const [label, s, field, op] of cases) {
    const rules = rulesOf(s);
    assert.ok(rules.some((r) => r.field === field && r.operator === op), `${label}: ${JSON.stringify(rules.map((r) => [r.field, r.operator]))}`);
    for (const r of rules) assert.ok(fieldKeys.has(r.field), `${label}: ${r.field} is a real filter field`);
    const checked = parseFilter(buildHomeFilter(s));
    assert.ok(checked.ok, `${label}: the validator accepts it (${JSON.stringify(checked)})`);
    assert.ok(compileFilterToWhere(buildHomeFilter(s), new Date(), "confirmed"), `${label}: the compiler accepts it`);
  }
  const multi = rulesOf({ ...base, mode: "directors", directors: "multiple" }).find((r) => r.field === "directorCount")!;
  assert.equal(String(multi.value), "2");
  assert.equal(buildHomeFilter(base).children.length, 0, "a plain text search adds no filters");
  assert.equal(rulesOf({ ...base, mode: "sic", sic: "62012", type: "ltd" }).length, 2, "filters combine");
});

test("the dropdown options are the application's real ones: the UK only, and the registry's company types, filings and director positions", () => {
  assert.deepEqual(COUNTRY_OPTIONS.map((o) => o.value), ["gb"]);
  assert.equal(COUNTRY_OPTIONS[0].label, "United Kingdom");
  const typeField = COMPANY_FILTER_FIELDS.find((f) => f.key === "type")!;
  assert.deepEqual(TYPE_OPTIONS, typeField.options);
  for (const f of FILING_OPTIONS) assert.ok(fieldKeys.has(f.field), f.field);
  assert.deepEqual(DIRECTOR_OPTIONS.map((o) => o.value), ["single", "multiple"]);
});

// ---- the address the widget sends the visitor to -------------------------------------------------------------------------------
test("the search address keeps only choices, and parses back to exactly the same search", () => {
  const searches: HomeSearch[] = [
    { ...base, q: "acme trading" },
    { ...base, q: "ab1 2cd", type: "plc" },
    { ...base, mode: "sic", sic: "62012", type: "ltd" },
    { ...base, mode: "filings", filing: "late-accounts", q: "north" },
    { ...base, mode: "directors", directors: "single" },
  ];
  for (const s of searches) {
    const href = homeSearchHref(s);
    assert.ok(href.startsWith("/companies?"), href);
    assert.deepEqual(parseHomeSearch(new URL(href, "http://x").searchParams), s, href);
  }
  assert.ok(!homeSearchHref({ ...base, q: "acme" }).includes("type="), "empty choices are left out");
  assert.equal(new URL(homeSearchHref({ ...base, q: "a&b=c#d" }), "http://x").searchParams.get("q"), "a&b=c#d", "special characters are encoded, not interpreted");
});

test("a free account is sent to its own search, and told when the chosen mode is not part of it", () => {
  assert.equal(customerSearchHref({ ...base, q: "acme" }), "/find-companies?q=acme");
  assert.equal(customerSearchHref({ ...base, mode: "sic", sic: "62012" }), "/find-companies?advanced=1");
  assert.equal(customerSearchHref({ ...base, mode: "filings", filing: "ds01" }), "/find-companies?advanced=1");
  assert.equal(customerSearchHref({ ...base, q: "acme", type: "ltd" }), "/find-companies?q=acme&advanced=1");
  assert.equal(customerSearchHref(base), "/find-companies");
});

// ---- return addresses: no open redirect ----------------------------------------------------------------------------------------
test("safeNextPath follows same-site paths only", () => {
  for (const ok of ["/dashboard", "/companies", "/companies?mode=sic&sic=62012", "/companies?q=a%20b&type=ltd", "/reports/new#top", "/find-companies?q=x"]) assert.equal(safeNextPath(ok), ok, ok);
  const bad: (string | null | undefined)[] = [
    null, undefined, "", "evil", "dashboard", "https://evil.example", "http://evil.example/x", "//evil.example", "///evil.example", "/\\evil.example", "\\\\evil.example",
    "javascript:alert(1)", "data:text/html,x", "/\t/evil.example", "/\nevil", `/${String.fromCharCode(0)}x`, "/a\\b", " /dashboard", "x".repeat(2100),
  ];
  for (const b of bad) assert.equal(safeNextPath(b), null, JSON.stringify(b));
  assert.equal(safeNextPath("/%2F%2Fevil.example"), "/%2F%2Fevil.example", "an encoded slash is a path segment, not a host");
  assert.equal(safeNextPath("/a/../b"), "/b", "dot segments are resolved, never left to climb out");
});

// ---- wiring (the clicks themselves are in the real-browser test) -----------------------------------------------------------------
test("the widget is a real form to /companies; the dead doorway link and static dropdowns are gone", () => {
  const w = read("src/components/marketing/LandingTabs.tsx");
  assert.match(w, /<form role="search"[^>]*action="\/companies" method="get"/);
  assert.ok(!/href="\/login\?next=\/companies"/.test(w));
  for (const t of ["company", "filings", "directors", "sic"]) assert.ok(w.includes(t));
  assert.match(w, /<select name=\{name\}/);
  assert.match(w, /COUNTRY_OPTIONS\.map/);
  assert.match(w, /TYPE_OPTIONS\.map/);
  assert.match(w, /validateHomeSearch\(search\)/);
  assert.match(w, /if \(editing \|\| busy\) \{\s*e\.preventDefault\(\)/, "no navigation from the editor canvas, no double submit");
  assert.match(w, /aria-busy=\{busy\}/);
});

test("the sign-in return path keeps the whole search and is validated before it is followed", () => {
  assert.match(read("src/proxy.ts"), /loginUrl\.searchParams\.set\("next", pathname \+ request\.nextUrl\.search\)/);
  const login = read("src/app/login/LoginForm.tsx");
  assert.match(login, /safeNextPath\(searchParams\.get\("next"\)\) \?\? "\/dashboard"/);
  assert.ok(!/searchParams\.get\("next"\) \|\| "\/dashboard"/.test(login), "the unvalidated version is gone");
  const page = read("src/app/(app)/companies/page.tsx");
  assert.match(page, /parseHomeSearch\(params\)/);
  assert.ok(!/customerSearchHref/.test(page), "Phase One: customers use the full search, not a redirect to the limited one");
  assert.match(page, /initialFilter=\{initialFilter\}/);
});

// ---- Corporate Structure ---------------------------------------------------------------------------------------------------------
test("all Corporate Structure motion is inside prefers-reduced-motion: no-preference, uses only transform and opacity, and nothing is hidden without script", () => {
  const css = read("src/app/globals.css");
  const start = css.indexOf("Corporate structure illustration");
  assert.ok(start > 0);
  const block = css.slice(start);
  const mq = block.indexOf("@media (prefers-reduced-motion: no-preference) {");
  assert.ok(mq > 0);
  const outside = block.slice(0, mq);
  assert.ok(!/@keyframes|animation\s*:|animation-delay/.test(outside), "no animation outside the no-preference block");
  const inside = block.slice(mq);
  assert.equal((inside.match(/@keyframes cs-/g) ?? []).length, 3);
  for (const kf of inside.match(/@keyframes cs-[\s\S]*?\n  \}\n/g) ?? []) assert.ok(!/\b(top|left|width|height|margin)\s*:/.test(kf), "keyframes only move transform / opacity: " + kf.slice(0, 40));
  assert.match(inside, /\.cs-root\[data-armed="true"\] \.cs-node \{\s*opacity: 0;/, "hidden only after script has armed the entrance");
  assert.ok(!/\.cs-node \{[^}]*opacity: 0/.test(outside), "visible by default");
  const comp = read("src/components/marketing/CorporateStructure.tsx");
  assert.match(comp, /rect\.top < window\.innerHeight \* 0\.9/, "content already on screen is never hidden and re-shown");
  assert.ok(!/useState|requestAnimationFrame|setInterval|setTimeout/.test(comp), "no state, timers or JS animation loop");
});
