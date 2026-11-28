// READ-ONLY database check, meant to run ON the server (Plesk -> Node.js -> Run Node.js commands).
// Copy this file to the app root as dbcheck.js, then run:  pkg set scripts.dbcheck="node dbcheck.js"
// and then:  run dbcheck
// Prints which database the site uses and row counts. Never prints a password.
const fs = require("fs");

for (const f of [".env", ".env.production", ".env.local"]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

if (!process.env.DATABASE_URL) {
  console.log("DATABASE_URL not found (not in Plesk variables or a .env file here)");
  process.exit(0);
}
const u = new URL(process.env.DATABASE_URL);
console.log("Database:", u.hostname + ":" + (u.port || 5432) + u.pathname, "| user:", u.username);

const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const [companies, directors, users] = await Promise.all([p.company.count(), p.director.count(), p.user.count()]);
  console.log("companies:", companies, "| directors:", directors, "| users:", users);
  const dbs = await p.$queryRawUnsafe("select datname from pg_database where not datistemplate order by 1");
  console.log("databases on server:", dbs.map((d) => d.datname).join(", "));
  try {
    const m = await p.$queryRawUnsafe(
      `select migration_name from "_prisma_migrations" where finished_at is not null order by finished_at desc limit 3`,
    );
    console.log("latest migrations:", m.map((r) => r.migration_name).join(", "));
  } catch (e) {
    console.log("migrations: " + e.message);
  }
})()
  .catch((e) => console.log("ERROR:", e.message))
  .finally(() => p.$disconnect());
