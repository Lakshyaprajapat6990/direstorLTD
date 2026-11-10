import { test } from "node:test";
import assert from "node:assert/strict";
import { isNonUkCompany, isUkEligible, NON_UK_COMPANY_TYPES, NON_UK_NUMBER_PREFIXES, NON_UK_SQL_PREDICATE, UK_AMBIGUOUS_TYPES } from "../../src/lib/companies-house/eligibility";
import { emptyMappingStats, mapCsvRecord, REQUIRED_COLUMNS } from "../../src/lib/companies-house/csv/mapping";
import { mapItem, TERMINAL_STATUSES } from "../../src/lib/companies-house/dissolvedImport";
import { mapSearchItem } from "../../src/lib/companies-house/newRegistrations";

test("overseas entities, overseas companies and UK establishments are not UK companies - by type", () => {
  for (const type of ["registered-overseas-entity", "oversea-company", "uk-establishment"]) assert.equal(isNonUkCompany({ type }), true, type);
  assert.deepEqual([...NON_UK_COMPANY_TYPES].sort(), ["oversea-company", "registered-overseas-entity", "uk-establishment"]);
});

test("the bulk file's 'Other company type' hides overseas companies, so FC / NF / SF / OE / BR numbers are caught by prefix", () => {
  for (const n of ["FC043620", "NF000006", "SF000109", "OE026880", "BR028742"]) assert.equal(isNonUkCompany({ companyNumber: n, type: "other" }), true, n);
  assert.deepEqual([...NON_UK_NUMBER_PREFIXES].sort(), ["BR", "FC", "NF", "OE", "SF"]);
});

test("UK companies are kept, including look-alike prefixes that are UK (SR / NR royal charters, GE groupings, SC, NI, OC, ZC, AC)", () => {
  for (const n of ["08209948", "SC123456", "NI019468", "OC301234", "LP012345", "SL000123", "SO300123", "CE012345", "SR000123", "NR000123", "GE000259", "ZC000011", "AC000001", "SA000038", "IP12345R", "RC000123"]) {
    assert.equal(isUkEligible({ companyNumber: n, type: "ltd" }), true, n);
  }
  for (const type of ["ltd", "plc", "llp", "other", "ukeig", "assurance-company", "unregistered-company", "royal-charter", "converted-or-closed"]) assert.equal(isUkEligible({ companyNumber: "00196807", type }), true, type);
});

test("a stored 'eeig' is ambiguous (the file labels UK and foreign groupings alike): never classified non-UK from the type", () => {
  assert.deepEqual([...UK_AMBIGUOUS_TYPES], ["eeig"]);
  assert.equal(isNonUkCompany({ companyNumber: "GE000003", type: "eeig" }), false);
});

function record(over: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, ""]));
  return { ...base, CompanyName: "X LTD", CompanyNumber: "08209948", "RegAddress.PostCode": "hg1 1nd", CompanyCategory: "Private Limited Company", CompanyStatus: "Active", IncorporationDate: "11/09/2012", ...over };
}

test("bulk file: an Overseas Entity / FC company is left out as ineligible, not rejected", () => {
  const oe = mapCsvRecord(record({ CompanyNumber: "OE026880", CompanyCategory: "Overseas Entity", CompanyStatus: "Active" }), emptyMappingStats());
  assert.ok(!oe.ok && oe.ineligible === true);
  const fc = mapCsvRecord(record({ CompanyNumber: "FC043620", CompanyCategory: "Other company type" }), emptyMappingStats());
  assert.ok(!fc.ok && fc.ineligible === true);
  const uk = mapCsvRecord(record({ CompanyNumber: "SC123456", CompanyCategory: "Other company type" }), emptyMappingStats());
  assert.ok(uk.ok);
  const bad = mapCsvRecord(record({ CompanyNumber: "08209948", IncorporationDate: "" }), emptyMappingStats());
  assert.ok(!bad.ok && !bad.ineligible, "a genuinely bad row is still a rejection");
});

test("dissolved import and new registrations: non-UK search hits are ineligible, UK ones map as before", () => {
  const base = { company_name: "N", company_status: "active", date_of_creation: "2026-11-05" };
  const d = mapItem({ ...base, company_number: "OE030001", company_type: "registered-overseas-entity" });
  assert.ok(!d.ok && d.ineligible === true);
  const d2 = mapItem({ ...base, company_number: "FC040001", company_type: "oversea-company" });
  assert.ok(!d2.ok && d2.ineligible === true);
  assert.ok(mapItem({ ...base, company_number: "16123456", company_type: "ltd" }).ok);
  const n = mapSearchItem({ ...base, company_number: "BR030001", company_type: "uk-establishment" });
  assert.ok(!n.ok && n.ineligible === true);
  assert.ok(mapSearchItem({ ...base, company_number: "16123456", company_type: "ltd" }).ok);
});

test("the SQL predicate used by the cleanup script covers every type and every prefix range", () => {
  for (const t of NON_UK_COMPANY_TYPES) assert.ok(NON_UK_SQL_PREDICATE.includes(`'${t}'`), t);
  for (const [p, next] of [["OE", "OF"], ["FC", "FD"], ["NF", "NG"], ["SF", "SG"], ["BR", "BS"]]) assert.ok(NON_UK_SQL_PREDICATE.includes(`>= '${p}' AND "companyNumber" < '${next}'`), p);
});

test("dissolved import reconciles every terminal status, never a live one", () => {
  assert.deepEqual([...TERMINAL_STATUSES], ["dissolved", "converted-closed", "removed", "closed"]);
});
