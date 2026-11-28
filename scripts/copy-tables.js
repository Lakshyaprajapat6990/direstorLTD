// Copies Companies House data tables from the local dev database into another database.
// Source: local dev DB (127.0.0.1:5433). Target: DATABASE_URL (set by copy-local-to-remote.ps1).
// Safe to re-run: rows that already exist in the target are skipped (ON CONFLICT DO NOTHING).
// User accounts and sessions are NOT copied.
const { Client } = require("pg");

const TABLES = ["Company", "Director", "OfficerCrawlCursor", "IngestionRun"]; // parent tables first
const BATCH = 2000;

async function connectTarget(url) {
  for (const ssl of [{ rejectUnauthorized: false }, false]) {
    const c = new Client({ connectionString: url, ssl, connectionTimeoutMillis: 15000 });
    try {
      await c.connect();
      return c;
    } catch (e) {
      if (!ssl) throw e;
    }
  }
}

async function main() {
  const src = new Client({ host: "127.0.0.1", port: 5433, user: "director", password: "director_dev_local", database: "director" });
  await src.connect();
  const dst = await connectTarget(process.env.DATABASE_URL);
  const t = new URL(process.env.DATABASE_URL);
  console.log(`Target: ${t.hostname}:${t.port || 5432}${t.pathname}`);

  for (const table of TABLES) {
    const cols = (
      await src.query(
        `select column_name from information_schema.columns
         where table_schema='public' and table_name=$1 and is_generated='NEVER' order by ordinal_position`,
        [table],
      )
    ).rows.map((r) => `"${r.column_name}"`);
    const pk = (
      await src.query(
        `select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
         where i.indrelid=$1::regclass and i.indisprimary`,
        [`"${table}"`],
      )
    ).rows.map((r) => r.attname);
    if (pk.length !== 1) throw new Error(`${table}: expected a single-column primary key`);
    const key = `"${pk[0]}"`;
    const list = cols.join(", ");
    const total = Number((await src.query(`select count(*) n from "${table}"`)).rows[0].n);

    let last = null;
    let done = 0;
    let inserted = 0;
    for (;;) {
      const r = await src.query(
        `select coalesce(json_agg(x), '[]') rows from
           (select ${list} from "${table}" ${last === null ? "" : `where ${key} > $1`} order by ${key} limit ${BATCH}) x`,
        last === null ? [] : [last],
      );
      const rows = r.rows[0].rows;
      if (!rows.length) break;
      last = rows[rows.length - 1][pk[0]];
      const ins = await dst.query(
        `insert into "${table}" (${list}) select ${list} from json_populate_recordset(null::"${table}", $1::json)
         on conflict do nothing`,
        [JSON.stringify(rows)],
      );
      done += rows.length;
      inserted += ins.rowCount;
      process.stdout.write(`\r${table}: ${done}/${total}`);
    }
    // Keep autoincrement sequences ahead of the copied ids.
    for (const s of (
      await dst.query(
        `select column_name from information_schema.columns
         where table_schema='public' and table_name=$1 and column_default like 'nextval%'`,
        [table],
      )
    ).rows) {
      await dst.query(
        `select setval(pg_get_serial_sequence($1, $2), coalesce((select max("${s.column_name}") from "${table}"), 1))`,
        [`"${table}"`, s.column_name],
      );
    }
    const now = (await dst.query(`select count(*) n from "${table}"`)).rows[0].n;
    console.log(`\r${table}: read ${done}, inserted ${inserted}, target now has ${now}`);
  }
  await src.end();
  await dst.end();
  console.log("Copy finished.");
}

main().catch((e) => {
  console.error("\nCOPY FAILED: " + e.message);
  process.exit(1);
});
