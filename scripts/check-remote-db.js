// Read-only check of a remote database. Started by check-remote-db.ps1, which passes
// the connection details in CHK_* environment variables (never on the command line).
const { Client } = require("pg");

(async () => {
  const base = {
    host: process.env.CHK_HOST,
    port: Number(process.env.CHK_PORT),
    database: process.env.CHK_DB,
    user: process.env.CHK_USER,
    password: process.env.CHK_PASS,
    connectionTimeoutMillis: 10000,
  };
  let c = null;
  for (const ssl of [{ rejectUnauthorized: false }, false]) {
    try {
      c = new Client({ ...base, ssl });
      await c.connect();
      console.log("Connected (ssl " + (ssl ? "on" : "off") + ")");
      break;
    } catch (e) {
      console.log("Try with ssl " + (ssl ? "on" : "off") + " failed: " + e.message);
      c = null;
    }
  }
  if (!c) process.exit(1);
  await c.query("SET default_transaction_read_only = on");
  console.log((await c.query("select version()")).rows[0].version);
  const dbs = await c.query("select datname from pg_database where not datistemplate order by 1");
  console.log("Databases on server: " + dbs.rows.map((r) => r.datname).join(", "));
  for (const t of ["User", "Company", "Director", "DailyDigest"]) {
    try {
      const r = await c.query(`select count(*)::bigint as n from "${t}"`);
      console.log(`${t.padEnd(12)} ${r.rows[0].n}`);
    } catch (e) {
      console.log(`${t.padEnd(12)} missing (${e.message})`);
    }
  }
  try {
    const m = await c.query(
      `select migration_name from "_prisma_migrations" where finished_at is not null order by finished_at desc limit 5`,
    );
    console.log("Latest migrations:");
    m.rows.forEach((r) => console.log("  " + r.migration_name));
  } catch (e) {
    console.log("No _prisma_migrations table: " + e.message);
  }
  await c.end();
})().catch((e) => {
  console.log("CHECK FAILED: " + e.message);
  process.exit(1);
});
