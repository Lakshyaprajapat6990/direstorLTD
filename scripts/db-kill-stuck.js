// Cancels database queries stuck for more than 10 minutes (leftovers from stopped scheduler runs). Their changes are rolled back
// and the scheduler redoes the work later. Website reads are never that long, so they are not touched.
//   Plesk: pkg set scripts.dbkill="node db-kill-stuck.js"   then   run dbkill
const fs = require("fs");
const path = require("path");
for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
  if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const rows = await p.$queryRawUnsafe(
    `select pid, extract(epoch from now()-query_start)::int as secs, left(regexp_replace(query,'\\s+',' ','g'),70) as q,
            pg_terminate_backend(pid) as killed
     from pg_stat_activity
     where backend_type='client backend' and datname=current_database() and pid <> pg_backend_pid()
       and state <> 'idle' and now()-query_start > interval '10 minutes'`);
  if (!rows.length) console.log("No stuck queries.");
  rows.forEach((r) => console.log(`${r.killed ? "Stopped" : "Could not stop"} (${r.secs}s): ${r.q}`));
})()
  .catch((e) => console.log("ERROR: " + e.message.replace(/postgres(ql)?:\/\/[^\s"']+/g, "***")))
  .finally(() => p.$disconnect());
