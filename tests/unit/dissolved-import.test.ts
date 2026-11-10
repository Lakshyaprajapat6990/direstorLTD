import { test } from "node:test";
import assert from "node:assert/strict";
import { mapItem, planWindows, splitWindow } from "../../src/lib/companies-house/dissolvedImport";

test("planWindows: contiguous, ordered, non-overlapping, covers the whole range", () => {
  const w = planWindows("1600-01-01", "2026-10-30");
  assert.equal(w[0].from, "1600-01-01");
  assert.equal(w[w.length - 1].to, "2026-10-30");
  for (let i = 1; i < w.length; i++) {
    const prevEnd = Date.parse(w[i - 1].to + "T00:00:00Z");
    assert.equal(Date.parse(w[i].from + "T00:00:00Z") - prevEnd, 86_400_000, `gap/overlap before ${w[i].from}`);
  }
});

test("planWindows: honours a narrow range", () => {
  assert.deepEqual(planWindows("2015-03-02", "2015-03-04"), [
    { from: "2015-03-02", to: "2015-03-02" },
    { from: "2015-03-03", to: "2015-03-03" },
    { from: "2015-03-04", to: "2015-03-04" },
  ]);
});

test("splitWindow: halves cover the parent exactly; a single day splits on dissolution date", () => {
  const [a, b] = splitWindow({ from: "2015-01-01", to: "2015-01-31" })!;
  assert.equal(a.from, "2015-01-01");
  assert.equal(b.to, "2015-01-31");
  assert.equal(Date.parse(b.from + "T00:00:00Z") - Date.parse(a.to + "T00:00:00Z"), 86_400_000);
  const [d1, d2] = splitWindow({ from: "2015-03-02", to: "2015-03-02" })!;
  assert.equal(d1.from, "2015-03-02");
  assert.ok(d1.dissolvedFrom && d2.dissolvedTo && d1.dissolvedTo! < d2.dissolvedFrom!);
});

test("mapItem: maps a dissolved hit and rejects incomplete ones", () => {
  const ok = mapItem({ company_number: "ni019468", company_name: "X LTD", company_status: "dissolved", company_type: "ltd", date_of_creation: "1986-05-13", date_of_cessation: "2016-02-09", sic_codes: ["25720"], registered_office_address: { postal_code: "bt35  9ln" } });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.row.companyNumber, "NI019468");
    assert.equal(ok.row.dissolutionDate, "2016-02-09");
    assert.equal(ok.row.postcode, "BT35 9LN");
  }
  assert.equal(mapItem({ company_number: "1", company_name: "X", company_status: "dissolved", company_type: "ltd" }).ok, false);
});
