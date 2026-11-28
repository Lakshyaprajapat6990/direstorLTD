// Prints the end of the newest website error logs (iisnode) and the scheduler logs, with secrets masked.
//   Plesk: pkg set scripts.errors="node show-errors.js"   then   run errors
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const mask = (s) =>
  s.replace(/postgres(ql)?:\/\/[^\s"']+/g, "postgresql://***").replace(/(key|secret|password|token)(["'\s:=]+)[^\s"',]+/gi, "$1$2***");

function tail(file, n) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
  console.log(`\n===== ${path.relative(dir, file)} (last ${n} lines) =====`);
  console.log(mask(lines.slice(-n).join("\n")));
}

const iis = path.join(dir, "iisnode");
if (fs.existsSync(iis)) {
  const files = fs.readdirSync(iis).filter((f) => f.endsWith(".txt")).map((f) => path.join(iis, f));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  files.slice(0, 2).forEach((f) => tail(f, 40));
  if (!files.length) console.log("iisnode folder has no log files");
} else console.log("No iisnode log folder in " + dir);

for (const f of ["web-errors.log", "web-launch.log", "scheduler.log"]) {
  const p = path.join(dir, "tmp-ingest", "logs", f);
  if (fs.existsSync(p)) tail(p, 15);
}
