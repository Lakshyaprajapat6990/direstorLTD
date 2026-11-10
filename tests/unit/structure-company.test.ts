import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CorporateStructure } from "../../src/components/marketing/CorporateStructure";
import { toStructureCompany, verifiedOwnership, type StructureCompany, type StructureRow } from "../../src/lib/data/structure-company";

const root = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const row: StructureRow = {
  id: "cid1",
  companyNumber: "01234567",
  name: "REGISTER TEST LIMITED",
  status: "active",
  type: "ltd",
  incorporationDate: new Date("2015-06-15T00:00:00Z"),
  directorCount: 3,
  officersCoverage: "full",
};
const render = (company: StructureCompany | null) => renderToStaticMarkup(createElement(CorporateStructure, { company }));

// ---- real data mapping --------------------------------------------------------------------------------------------------------------
test("a register row maps to exactly its own facts: name, number, status, readable type, date, confirmed officers", () => {
  assert.deepEqual(toStructureCompany(row), {
    id: "cid1",
    companyNumber: "01234567",
    name: "REGISTER TEST LIMITED",
    status: "Active",
    typeLabel: "Private limited company",
    incorporated: "15 Jun 2015",
    officers: 3,
  });
  assert.equal(toStructureCompany({ ...row, type: "llp" }).typeLabel, "Limited liability partnership");
  assert.equal(toStructureCompany({ ...row, type: "something-new" }).typeLabel, "Company", "an unknown type is not guessed");
  assert.equal(toStructureCompany({ ...row, status: "voluntary-arrangement" }).status, "Voluntary arrangement");
});

test("officers are only counted when they were confirmed: unknown is never shown as zero or as a number", () => {
  for (const coverage of ["none", "unavailable", ""]) assert.equal(toStructureCompany({ ...row, officersCoverage: coverage, directorCount: 0 }).officers, null, coverage);
  assert.equal(toStructureCompany({ ...row, officersCoverage: "none", directorCount: 7 }).officers, null, "a placeholder count is not confirmed data");
  const html = render(toStructureCompany({ ...row, officersCoverage: "none", directorCount: 0 }));
  assert.match(html, /Not yet confirmed/);
  assert.match(render(toStructureCompany(row)), /3 confirmed/);
});

test("the section shows the real record and links to it, using actual name and number", () => {
  const html = render(toStructureCompany(row));
  for (const s of ["REGISTER TEST LIMITED", "01234567", "Active", "Private limited company", "15 Jun 2015", "Real company record"]) assert.ok(html.includes(s), s);
  assert.ok(html.includes('href="/companies/cid1"'), "links to the company's own record");
  assert.ok(html.includes('href="/companies"'), "offers the existing search for another company");
});

// ---- missing ownership data ---------------------------------------------------------------------------------------------------------
test("ownership is reported unavailable, with a reason and no names", () => {
  const o = verifiedOwnership();
  assert.deepEqual(Object.keys(o).sort(), ["reason", "state"]);
  assert.equal(o.state, "unavailable");
});

test("parent, subsidiaries and beneficial owners are three empty slots that say so, with no name, number or percentage", () => {
  const html = render(toStructureCompany(row));
  assert.equal((html.match(/DNL<span class="sr-only">: data unavailable<\/span>/g) ?? []).length, 3, "one DNL per slot");
  for (const s of ["Parent company", "Subsidiaries", "Beneficial owners", "Ownership data: DNL"]) assert.ok(html.includes(s), s);
  assert.ok(!/Not available|No verified/.test(html), "the earlier wording is replaced by DNL");
  assert.match(html, /DNL marks data that is unavailable; it does not mean that no relationship exists/);
  assert.ok(!/DNL (stands for|means|=)|Data Not/i.test(html + read("src/components/marketing/CorporateStructure.tsx")), "the abbreviation is not expanded");
  assert.match(html, /does not hold parent, subsidiary or beneficial ownership data, so no relationship is shown or implied/);
  assert.ok(!/\d+(\.\d+)?\s*%/.test(html), "no ownership percentage");
  assert.ok(!/Example (Holdings|Trading|Services|Property|Person)/.test(html), "the earlier invented names are gone");
});

// ---- empty result -------------------------------------------------------------------------------------------------------------------
test("with no company to show, the section says so and still invents nothing", () => {
  const html = render(null);
  assert.match(html, /No real company record could be loaded right now, so none is shown/);
  assert.match(html, /No company to show/);
  assert.equal((html.match(/DNL<span class="sr-only">/g) ?? []).length, 3);
  assert.ok(!html.includes("/companies/"), "no company link without a company");
  assert.ok(!/Company number/.test(html));
});

// ---- no fabricated relationships ------------------------------------------------------------------------------------------------------
test("nothing in the data layer or the component can produce a relationship", () => {
  const data = read("src/lib/data/structure-company.ts");
  const comp = read("src/components/marketing/CorporateStructure.tsx");
  assert.ok(!/parent|subsidiar|owner|psc|shareholder|percent/i.test(Object.keys(toStructureCompany(row)).join(" ")), "the mapped record has no relationship fields");
  assert.ok(!/db\.director|\.directors\b|include:\s*\{\s*directors/.test(data), "officer appointments are never read, so a corporate director cannot be turned into an owner");
  assert.ok(!/fetch\(|https?:\/\//.test(data + comp), "no external source");
  assert.ok(!/Example /.test(comp), "no invented example names");
  for (const real of ["LVMH", "Tiffany", "Sephora", "Dior", "Bulgari"]) assert.ok(!comp.includes(real), real);
  assert.ok(!/useState|setTimeout|setInterval/.test(comp));
});

test("the homepage passes the loaded company to the section, and the editor canvas and previews show the same real record", () => {
  assert.match(read("src/components/marketing/HomeView.tsx"), /<CorporateStructure company=\{structure\} \/>/);
  assert.match(read("src/app/page.tsx"), /getStructureCompany\(\)/);
  assert.match(read("src/app/page.tsx"), /structure=\{structure\}/);
  assert.match(read("src/app/website-preview/page.tsx"), /structure=\{structure\}/);
  assert.match(read("src/app/website-preview/editor/page.tsx"), /structure=\{structure\}/);
  assert.match(read("src/app/website-preview/editor/EditorCanvas.tsx"), /structure=\{structure\}/);
  assert.match(read("src/components/marketing/HomeView.tsx"), /are not part of the data DIRECTOR\.LTD holds today, so none is shown or implied/);
});
