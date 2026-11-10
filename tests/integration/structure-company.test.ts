import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, makeCompany } from "./helpers";
import { getStructureCompany, verifiedOwnership } from "../../src/lib/data/structure-company";

// The Corporate structure section's company comes from the register, chosen by fixed rules, and nothing about ownership is ever read.
const TAG = `STRC${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const NUMBERS = ["00000001", "00000002", "00000003", "00000004", "00000005"];

after(async () => {
  await db.company.deleteMany({ where: { companyNumber: { in: NUMBERS }, name: { startsWith: TAG } } });
  await db.$disconnect();
});

test("only a real, active company with confirmed officers is chosen, lowest company number first; seed, dissolved, unfetched and zero-officer rows are skipped", async () => {
  const taken = await db.company.findMany({ where: { companyNumber: { in: NUMBERS } }, select: { companyNumber: true } });
  assert.deepEqual(taken, [], "the numbers this test needs are free");
  await makeCompany({ companyNumber: "00000001", name: `${TAG} SEED`, source: "seed", officersCoverage: "full", directorCount: 2 });
  await makeCompany({ companyNumber: "00000002", name: `${TAG} DISSOLVED`, status: "dissolved", officersCoverage: "full", directorCount: 2 });
  await makeCompany({ companyNumber: "00000003", name: `${TAG} UNFETCHED`, officersCoverage: "none", directorCount: 4 });
  await makeCompany({ companyNumber: "00000004", name: `${TAG} ZERO`, officersCoverage: "full", directorCount: 0 });
  await makeCompany({ companyNumber: "00000005", name: `${TAG} ELIGIBLE`, officersCoverage: "full", directorCount: 2, type: "llp" });
  const c = await getStructureCompany(0);
  assert.ok(c, "a company is found");
  assert.equal(c.companyNumber, "00000005");
  assert.equal(c.name, `${TAG} ELIGIBLE`);
  assert.equal(c.typeLabel, "Limited liability partnership");
  assert.equal(c.status, "Active");
  assert.equal(c.officers, 2);
  assert.deepEqual(Object.keys(c).sort(), ["companyNumber", "id", "incorporated", "name", "officers", "status", "typeLabel"], "only the company's own facts leave the data layer");
  const again = await getStructureCompany(0);
  assert.equal(again?.id, c.id, "the same company every time");
});

test("the register holds no parent, subsidiary or ownership data to read, and the answer says so", async () => {
  const cols = (await db.$queryRawUnsafe(`select table_name, column_name from information_schema.columns where table_schema = 'public' and (column_name ~* '(psc|parent|subsid|beneficial|shareholder|ownership|percent)' or table_name ~* '(psc|parent|subsid|owner)')`)) as { table_name: string; column_name: string }[];
  assert.deepEqual(cols.filter((c) => !(c.table_name === "Report" && c.column_name === "ownerId")), [], "no ownership table or column exists");
  assert.equal(verifiedOwnership().state, "unavailable");
});
