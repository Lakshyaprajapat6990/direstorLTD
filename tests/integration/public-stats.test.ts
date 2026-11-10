import { test, after } from "node:test";
import assert from "node:assert/strict";
import { db, makeCompany } from "./helpers";
import { getRegisterBreakdown } from "../../src/lib/data/companies";
import { getPublicSiteStats } from "../../src/lib/data/public-stats";

after(async () => {
  await db.$disconnect();
});

// Real PostgreSQL (the scratch database only: helpers.ts refuses anything else). The public figures must equal an independent
// count of the same rows, must ignore synthetic "seed" rows, and must be the very numbers the dashboard reads.
test("public register figures match the database, exclude seed rows, and equal the dashboard's breakdown", async () => {
  await makeCompany({ source: "seed", status: "active" });
  await makeCompany({ source: "seed", status: "dissolved" });
  await makeCompany({ source: "bulk_import", status: "active" });
  await makeCompany({ source: "bulk_import", status: "liquidation" });
  await makeCompany({ source: "stream", status: "dissolved" });
  await makeCompany({ source: "bulk_import", status: "active", officersCoverage: "full", directorCount: 2 });
  await makeCompany({ source: "bulk_import", status: "active", officersCoverage: "unavailable" });

  const real = { source: { not: "seed" } };
  const [total, active, dissolved, confirmed, seedRows] = await Promise.all([
    db.company.count({ where: real }),
    db.company.count({ where: { ...real, status: "active" } }),
    db.company.count({ where: { ...real, status: "dissolved" } }),
    db.company.count({ where: { ...real, officersCoverage: "full", directorCount: { gt: 0 } } }),
    db.company.count({ where: { source: "seed" } }),
  ]);
  assert.ok(seedRows >= 2, "the test needs seed rows to prove they are excluded");

  const stats = await getPublicSiteStats();
  assert.equal(stats.state, "ok");
  if (stats.state !== "ok") return;
  assert.deepEqual(stats.register, { total, active, dissolved, directorsConfirmed: confirmed, other: total - active - dissolved });
  assert.ok(confirmed >= 1 && dissolved >= 1, "fixtures cover confirmed directors and a dissolved company");

  // Same function, same cache: identical to what the dashboard renders.
  const { total: t, active: a, dissolved: d, directorsConfirmed: c } = await getRegisterBreakdown();
  assert.deepEqual({ total: t, active: a, dissolved: d, directorsConfirmed: c }, { total, active, dissolved, directorsConfirmed: confirmed });
});

test("'confirmed directors' counts only fully fetched companies with a current director, never empty, unfetched or unavailable rows", async () => {
  await makeCompany({ source: "bulk_import", status: "active", officersCoverage: "full", directorCount: 0 }); // empty officer answer
  const { directorsConfirmed } = await getRegisterBreakdown();
  const withDirector = await db.company.count({ where: { source: { not: "seed" }, officersCoverage: "full", directorCount: { gt: 0 } } });
  assert.equal(directorsConfirmed, withDirector);
});
