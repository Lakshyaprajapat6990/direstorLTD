import "./load-env";
// Daily digest by hand (the scheduler builds it automatically when DAILY_DIGEST_ENABLED=1).
//   npm run jobs:daily-digest                          build the digest of yesterday (UTC), and store it for download
//   npm run jobs:daily-digest -- --date 2026-11-25     build (or rebuild) the digest of that UTC day
//   npm run jobs:daily-digest -- --date 2026-11-25 --out ./digests   also write the .xlsx and .pdf to that folder
// Reads the database only: it makes no Companies House requests.
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db";
import { digestFileName, loadDigestConfig, previousUtcDay, runDailyDigest } from "../src/lib/digest/dailyDigest";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main() {
  const dateArg = opt("date");
  if (dateArg && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) throw new Error("--date must be YYYY-MM-DD");
  const day = dateArg ? new Date(`${dateArg}T00:00:00.000Z`) : previousUtcDay(new Date());
  const result = await runDailyDigest({ day, cfg: loadDigestConfig(), log: (m) => console.log(m) });
  console.log(JSON.stringify(result, null, 2));

  const out = opt("out");
  if (out) {
    const row = await db.dailyDigest.findUnique({ where: { day }, select: { xlsx: true, pdf: true } });
    if (!row) throw new Error("the digest row was not found after building it");
    fs.mkdirSync(out, { recursive: true });
    for (const [ext, data] of [["xlsx", row.xlsx], ["pdf", row.pdf]] as const) {
      const file = path.join(out, digestFileName(day, ext));
      fs.writeFileSync(file, Buffer.from(data));
      console.log(`Wrote ${file}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
