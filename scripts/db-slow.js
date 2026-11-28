// Shows what the database is busy with right now: connections, running queries and how long they take. Read-only.
//   Plesk: pkg set scripts.dbslow="node db-slow.js"   then   run dbslow
const fs = require("fs");
const path = require("path");
for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
  if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const [{ max }] = await p.$queryRawUnsafe(`select setting::int as max from pg_settings where name='max_connections'`);
  const byState = await p.$queryRawUnsafe(
    `select datname as db, coalesce(state,'?') as state, count(*)::int as n from pg_stat_activity where backend_type='client backend' group by 1,2 order by 3 desc`);
  console.log(`max_connections: ${max}`);
  console.log("Connections:");
  byState.forEach((r) => console.log(`  ${r.db} ${r.state}: ${r.n}`));
  const running = await p.$queryRawUnsafe(
    `select pid, extract(epoch from now()-query_start)::int as secs, state, wait_event_type as wait, left(regexp_replace(query,'\\s+',' ','g'),160) as q
     from pg_stat_activity where backend_type='client backend' and state <> 'idle' and pid <> pg_backend_pid() order by secs desc limit 15`);
  console.log("\nRunning queries (longest first):");
  running.forEach((r) => console.log(`  ${r.secs}s [${r.state}${r.wait ? "/" + r.wait : ""}] ${r.q}`));
  const cpu = await p.$queryRawUnsafe(`select count(*)::int as n from pg_stat_activity where state='active'`);
  console.log(`\nActive right now: ${cpu[0].n}`);
})()
  .catch((e) => console.log("ERROR: " + e.message.replace(/postgres(ql)?:\/\/[^\s"']+/g, "***")))
  .finally(() => p.$disconnect());
