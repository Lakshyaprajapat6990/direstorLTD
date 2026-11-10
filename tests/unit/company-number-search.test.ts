import { test } from "node:test";
import assert from "node:assert/strict";
import { companyNumberSearchKeys } from "../../src/lib/filters/companyNumberQuery";
import { withSearchAsFilter } from "../../src/lib/filters/searchToFilter";
import { buildCompanyWhere } from "../../src/lib/data/companies";
import { makeId, type FilterGroupNode } from "../../src/lib/filters/types";

test("companyNumberSearchKeys: recognises company-number shapes", () => {
  assert.deepEqual(companyNumberSearchKeys("NI019468"), ["NI019468"]);
  assert.deepEqual(companyNumberSearchKeys("sc004688"), ["SC004688"]);
  assert.deepEqual(companyNumberSearchKeys(" R0000017 "), ["R0000017"]);
  assert.deepEqual(companyNumberSearchKeys("03658691"), ["03658691"]);
});

test("companyNumberSearchKeys: names, postcodes and PARTIAL numbers keep the existing contains search", () => {
  for (const t of ["TOP SECURITY FENCING", "BT35 9LN", "BT359LN", "2020", "12345", "SW1A", "ACME", "", "   ", "123456789", "SC12345678", "NI 019468", "000057", "3658691", "PF0000", "NI19468"]) {
    assert.equal(companyNumberSearchKeys(t), null, `"${t}" must not be treated as a company number`);
  }
});

test("buildCompanyWhere: number-shaped input is an exact match, others keep name / number / postcode", () => {
  const json = (o: unknown) => JSON.stringify(o);
  assert.ok(json(buildCompanyWhere({ q: "NI019468" })).includes('"companyNumber":{"in":["NI019468"]}'));
  assert.ok(!json(buildCompanyWhere({ q: "NI019468" })).includes("contains"));
  const text = json(buildCompanyWhere({ q: "BT35 9LN" }));
  assert.ok(text.includes('"name":{"contains":"BT35 9LN"') && text.includes('"companyNumber":{"contains":"BT35 9LN"') && text.includes('"registeredPostcode":{"contains":"BT35 9LN"'));
  const name = json(buildCompanyWhere({ q: "top security" }));
  assert.ok(name.includes('"name":{"contains":"top security"'));
});

test("withSearchAsFilter: a saved report keeps the same meaning as the search box", () => {
  const empty: FilterGroupNode = { id: makeId(), kind: "group", combinator: "AND", children: [] };
  const num = JSON.stringify(withSearchAsFilter(empty, "03658691", null));
  assert.ok(num.includes('"field":"companyNumber","operator":"equals","value":"03658691"'));
  assert.ok(!num.includes('"operator":"contains"'));
  const partial = JSON.stringify(withSearchAsFilter(empty, "000057", null));
  assert.ok(partial.includes('"field":"companyNumber","operator":"contains","value":"000057"'));
  const txt = JSON.stringify(withSearchAsFilter(empty, "BT35", null));
  assert.ok(txt.includes('"field":"name","operator":"contains"') && txt.includes('"field":"registeredPostcode","operator":"contains"'));
});
