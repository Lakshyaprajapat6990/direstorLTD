// Diagnostic for Plesk (Run Node.js commands): starts the scheduler supervisor for ~45 s, shows what it printed and the
// end of tmp-ingest\logs\scheduler.log, then stops it again (stop file). Nothing secret is printed.
//   pkg set scripts.schedtry="node scheduler-try.js"   then   run schedtry
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const dir = fs.realpathSync.native(__dirname);
const ps1 = path.join(dir, "scripts", "run-production-scheduler.ps1");
const logFile = path.join(dir, "tmp-ingest", "logs", "scheduler.log");
const stopFile = path.join(dir, "tmp-ingest", "production-scheduler.stop");
console.log("App folder: " + dir);
console.log("Supervisor exists: " + fs.existsSync(ps1));
try { fs.unlinkSync(stopFile); } catch {}

const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "") };
const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1], { cwd: dir, env, windowsHide: true });
child.on("error", (e) => console.log("COULD NOT START powershell: " + e.message));
child.stdout.on("data", (d) => process.stdout.write("[ps] " + d));
child.stderr.on("data", (d) => process.stdout.write("[ps-err] " + d));
child.on("exit", (code) => console.log("supervisor exited early with code " + code));

setTimeout(() => {
  fs.mkdirSync(path.dirname(stopFile), { recursive: true });
  fs.writeFileSync(stopFile, "diagnostic stop");
  console.log("\n--- last lines of scheduler.log ---");
  if (fs.existsSync(logFile)) {
    const lines = fs.readFileSync(logFile, "utf8").trim().split(/\r?\n/).slice(-25);
    // Lines are JSON log entries or supervisor messages; strip anything that looks like a connection string just in case.
    console.log(lines.map((l) => l.replace(/postgres(ql)?:\/\/[^\s"]+/g, "postgresql://***")).join("\n"));
  } else console.log("(no scheduler.log was written)");
  setTimeout(() => {
    try { fs.unlinkSync(stopFile); } catch {}
    try { child.kill(); } catch {}
    console.log("\nDiagnostic finished (stop file removed again).");
    process.exit(0);
  }, 20000);
}, 45000);
