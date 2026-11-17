import "./load-env";
// Dissolved-company random sample (see src/lib/companies-house/dissolvedSample.ts).
//   npm run jobs:dissolved-sample -- status                         read-only: the sample, per dissolution year, and the resulting estimate
//   npm run jobs:dissolved-sample -- tag-pilot <ids.json>           tag the already-fetched pilot companies (a JSON array of company ids, or {results:[{id}]})
//   npm run jobs:dissolved-sample -- draw [--per-year 150]          choose the random sample (writes DissolvedSample rows only; NO API call)
//   npm run jobs:dissolved-sample -- run [--max-requests 3000] [--batch 100] [--cap 100000]   fetch selected companies (LIVE Companies House calls)
import fs from "node:fs";
import { db } from "../src/lib/db";
import { drawSample, runSampleBatches, tagPilot, requestsSpentToday } from "../src/lib/companies-house/dissolvedSample";
import { computeAppointmentEstimate, loadSampleStrata } from "../src/lib/data/director-progress";
import { estimateDissolvedFromSample } from "../src/lib/data/director-progress-calc";
import { loadOfficerConfig } from "../src/lib/companies-house/officerQueue";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

async function status() {
  const sample = await loadSampleStrata();
  const rows = await db.$queryRaw<{ y: number; checked: bigint; unchecked: bigint; total: bigint }[]>`
    SELECT GREATEST(2009, coalesce(extract(year FROM "dissolutionDate")::int, 2009)) AS y,
           count(*) FILTER (WHERE "officersCoverage" IN ('full','unavailable')) AS checked,
           count(*) FILTER (WHERE "officersCoverage" = 'none') AS unchecked, count(*) AS total
      FROM "Company" WHERE "status" = 'dissolved' AND "source" <> 'seed' GROUP BY 1 ORDER BY 1`;
  const states = await db.$queryRaw<{ stratum: number; status: string; n: bigint }[]>`SELECT "stratum", "status", count(*) AS n FROM "DissolvedSample" GROUP BY 1, 2`;
  const unchecked = new Map(rows.map((r) => [Number(r.y), Number(r.unchecked)]));
  const est = estimateDissolvedFromSample(unchecked, sample);
  console.log("year | dissolved | individually checked | unchecked (U) | sample resolved n | mean rec/co | stratum est. total (95% range) | covered | sample states");
  for (const s of est.strata) {
    const r = rows.find((x) => Number(x.y) === s.year);
    const st = states.filter((x) => Number(x.stratum) === s.year).map((x) => `${x.status}:${x.n}`).join(" ");
    console.log(`${s.year} | ${r ? Number(r.total) : 0} | ${r ? Number(r.checked) : 0} | ${s.unchecked} | ${s.n} | ${s.mean.toFixed(3)} | ${s.total} (${s.low}-${s.high}) | ${s.covered ? "yes" : "NO"} | ${st}`);
  }
  console.log(`dissolved estimate: ${Math.round(est.total)} records for ${Math.round(est.covered)} unchecked dissolved companies (estimated, NOT individually checked); ${est.uncovered} unchecked dissolved companies without a usable sample; sample resolved ${est.sampled}`);
  const e = await computeAppointmentEstimate();
  if (e) console.log(`all-status estimate: remaining ${e.total} (95% ${e.low}-${e.high}); imported ${e.imported}; total ${e.imported + e.total}; dissolved individually checked ${e.dissolvedChecked}; provisional ${e.provisional}; uncovered ${e.uncoveredCompanies}`);
}

(async () => {
  if (cmd === "status") await status();
  else if (cmd === "tag-pilot") {
    const j = JSON.parse(fs.readFileSync(args[1], "utf8"));
    const ids: string[] = (Array.isArray(j) ? j : j.results).map((x: string | { id: string }) => (typeof x === "string" ? x : x.id));
    console.log(JSON.stringify(await tagPilot(ids)));
  } else if (cmd === "draw") {
    const batch = `full-${new Date().toISOString().slice(0, 10)}`;
    const res = await drawSample({ perYear: Number(opt("per-year") ?? 150), batch, kind: "full" });
    for (const r of res) console.log(`${r.year}: frame ${r.frame}, already in sample ${r.existing}, drawn ${r.drawn}`);
  } else if (cmd === "run") {
    const cap = opt("cap") !== undefined ? Number(opt("cap")) : loadOfficerConfig().dailyRequestCap;
    console.log(`daily cap ${cap || "none"}, spent today (ledger) ${await requestsSpentToday()}`);
    const before = await requestsSpentToday();
    const rep = await runSampleBatches({ batchSize: Number(opt("batch") ?? 100), maxRequests: Number(opt("max-requests") ?? 3000), dailyCap: cap || null, pauseMs: 250, log: (m) => console.log(m) });
    console.log(JSON.stringify(rep));
    console.log(`ledger today before ${before}, after ${await requestsSpentToday()} (other jobs share the ledger, so the difference is at least this run's ${rep.requests})`);
  } else {
    console.log("usage: status | tag-pilot <file> | draw [--per-year N] | run [--max-requests N] [--batch N] [--cap N]");
    process.exitCode = 1;
  }
  await db.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
