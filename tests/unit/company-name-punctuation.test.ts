import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "csv-parse/sync";
import { emptyMappingStats, mapCsvRecord } from "../../src/lib/companies-house/csv/mapping";

// Company names show exactly as Companies House publishes them. Quotation marks and apostrophes seen on /companies are part of the
// registered names (the raw bulk file carries them, and the stored names are byte-identical to it); DIRECTOR.LTD adds and removes none.
// These rows are real lines from the Companies House bulk file, in its own CSV quoting: a name is wrapped in "..." and an inner "
// is doubled, so  "''LA VITA"" CONSTRUCTION LTD"  is the name  ''LA VITA" CONSTRUCTION LTD.
const root = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const HEADER = "CompanyName, CompanyNumber,RegAddress.CareOf,RegAddress.POBox,RegAddress.AddressLine1, RegAddress.AddressLine2,RegAddress.PostTown,RegAddress.County,RegAddress.Country,RegAddress.PostCode,CompanyCategory,CompanyStatus,CountryOfOrigin,DissolutionDate,IncorporationDate,Accounts.AccountRefDay,Accounts.AccountRefMonth,Accounts.NextDueDate,Accounts.LastMadeUpDate,Accounts.AccountCategory,Returns.NextDueDate,Returns.LastMadeUpDate,Mortgages.NumMortCharges,Mortgages.NumMortOutstanding,Mortgages.NumMortPartSatisfied,Mortgages.NumMortSatisfied,SICCode.SicText_1,SICCode.SicText_2,SICCode.SicText_3,SICCode.SicText_4,LimitedPartnerships.NumGenPartners,LimitedPartnerships.NumLimPartners,URI,PreviousName_1.CONDATE, PreviousName_1.CompanyName, PreviousName_2.CONDATE, PreviousName_2.CompanyName,PreviousName_3.CONDATE, PreviousName_3.CompanyName,PreviousName_4.CONDATE, PreviousName_4.CompanyName,PreviousName_5.CONDATE, PreviousName_5.CompanyName,PreviousName_6.CONDATE, PreviousName_6.CompanyName,PreviousName_7.CONDATE, PreviousName_7.CompanyName,PreviousName_8.CONDATE, PreviousName_8.CompanyName,PreviousName_9.CONDATE, PreviousName_9.CompanyName,PreviousName_10.CONDATE, PreviousName_10.CompanyName,ConfStmtNextDueDate,ConfStmtLastMadeUpDate";
const raw = (csvName: string, number: string) => `${csvName},"${number}","","","1 TEST STREET","","LONDON","","ENGLAND","E1 1AA","Private Limited Company","Active","United Kingdom","","01/02/2020","31","3","31/12/2026","31/03/2025","FULL","","","0","0","0","0","62012 - Business and domestic software development","","","","0","0","http://example.test/${number}","","","","","","","","","","","","","","","","","","","","","","","31/05/2026","17/05/2025"`;

const CASES: [string, string, string, string][] = [
  // [name as written in the CSV, company number, the name that must be stored and shown, why]
  [`"''DIMI K'' LTD"`, "10325674", "''DIMI K'' LTD", "two apostrophes at each end (looks like a double quote in the page font)"],
  [`"''LA VITA"" CONSTRUCTION LTD"`, "14590431", `''LA VITA" CONSTRUCTION LTD`, "an inner double quote, doubled by CSV quoting"],
  [`"""WONDER YEARS CENTRE OF EXCELLENCE"""`, "04277902", `"WONDER YEARS CENTRE OF EXCELLENCE"`, "a name registered inside double quotes"],
  [`"""ANDI'S GIFT"""`, "CE012989", `"ANDI'S GIFT"`, "double quotes around a name that also holds an apostrophe"],
  [`"'77MELTDAWN LTD"`, "17407002", "'77MELTDAWN LTD", "a leading apostrophe"],
  [`"'2=1(UK)'"`, "03137448", "'2=1(UK)'", "apostrophes at both ends"],
  [`"'A' RECORDINGS LTD"`, "06477864", "'A' RECORDINGS LTD", "a quoted single letter"],
  [`"'A & A' SELF-STORAGE LTD."`, "03107220", "'A & A' SELF-STORAGE LTD.", "an ampersand, periods and a hyphen"],
  [`"'19 BY TWENTY C.I.C."`, "11111111", "'19 BY TWENTY C.I.C.", "a leading apostrophe on a year"],
  [`"IJEBU IGBO DESCENDANTS ""OMO ORIMOLUSI"" (UK)"`, "06408579", `IJEBU IGBO DESCENDANTS "OMO ORIMOLUSI" (UK)`, "inner double quotes in the middle of a name"],
  [`"A & B (UK) LIMITED"`, "22222222", "A & B (UK) LIMITED", "an ordinary name is untouched"],
];

function storedName(csvName: string, number: string): string {
  const [record] = parse(`${HEADER}\n${raw(csvName, number)}\n`, { columns: (h: string[]) => h.map((x) => x.trim()), skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as Record<string, string>[];
  const mapped = mapCsvRecord(record, emptyMappingStats());
  assert.ok(mapped.ok, JSON.stringify(mapped));
  return mapped.row.name;
}

test("the import keeps each registered name exactly as Companies House publishes it: quotes, apostrophes, ampersands, periods", () => {
  for (const [csvName, number, expected, why] of CASES) assert.equal(storedName(csvName, number), expected, `${number}: ${why}`);
});

test("only the CSV's own wrapping is removed: a name whose own first and last characters are quotes keeps them", () => {
  assert.equal(storedName(`"""B"""`, "CE033707"), `"B"`);
  assert.equal(storedName(`"""F.H.GREENAWAY"""`, "LP002617"), `"F.H.GREENAWAY"`);
  assert.equal(storedName(`"'A' PLUS ACCOUNTANTS LIMITED"`, "33333333"), "'A' PLUS ACCOUNTANTS LIMITED");
});

test("names are not trimmed, truncated or re-cased beyond surrounding spaces", () => {
  const long = "'A' RATED EFFICIENCY HEATING & PLUMBING LIMITED";
  assert.equal(storedName(`"${long}"`, "44444444"), long);
  assert.equal(storedName(`"  ''X''  LTD  "`, "55555555"), "''X''  LTD", "inner spacing is the register's own; only the ends are trimmed");
});

// ---- the page draws the stored name as plain text, adding nothing ------------------------------------------------------------------------
test("the results table draws row.name as plain text: no quote characters are added, and no formatting helper touches it", () => {
  const t = read("src/components/companies/ResultsTable.tsx");
  assert.match(t, /title=\{row\.name\}/);
  assert.match(t, />\s*\{row\.name\}\s*<\/Link>/);
  assert.ok(!/>\s*["'“”‘’&]+[a-z;#0-9]*\s*\{row\.name\}|\{row\.name\}\s*["'“”‘’]+\s*</.test(t), "no quotes are placed around the visible name");
  assert.ok(!/row\.name\.(replace|slice|substring|trim|split)|replace\([^)]*row\.name/.test(t), "the name is not rewritten");
  const css = read("src/app/globals.css");
  assert.ok(!/\bquotes\s*:|::before\s*\{[^}]*content:\s*open-quote/.test(css), "no stylesheet rule adds quotation marks");
});

test("a name with quotes renders as escaped text, never as markup, and keeps every character", () => {
  const names = [`''DIMI K'' LTD`, `''LA VITA" CONSTRUCTION LTD`, `"WONDER YEARS CENTRE OF EXCELLENCE"`, "'A & A' SELF-STORAGE LTD.", `<b>"X"</b> LTD`];
  for (const name of names) {
    const html = renderToStaticMarkup(createElement("a", { href: "/companies/x", title: name }, name));
    const text = html.replace(/^<a[^>]*>/, "").replace(/<\/a>$/, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    assert.equal(text, name);
    assert.ok(!html.includes("<b>"), "no markup comes out of a name");
  }
});
