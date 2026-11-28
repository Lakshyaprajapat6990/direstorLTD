// Startup file for Plesk on Windows (IIS + iisnode). Copy to the app root as start.js and set it as the
// "Application Startup File" in Plesk -> Node.js.
//
// iisnode passes the address to listen on in PORT (a named pipe, not a number), so we use Next.js's own request handler
// on a plain http server. The folder path is taken in its TRUE letter case (C:\inetpub vs C:\Inetpub): mixed spellings
// make Node load React twice, which breaks every page.
process.env.NODE_ENV = "production";

const fs = require("fs");
const http = require("http");
const path = require("path");

const dir = fs.realpathSync.native(__dirname);
process.chdir(dir);

// Website errors -> tmp-ingest\logs\web-errors.log (iisnode logging is off on this host). Connection strings are masked.
const errLog = path.join(dir, "tmp-ingest", "logs", "web-errors.log");
try { fs.mkdirSync(path.dirname(errLog), { recursive: true }); } catch {}
// Next.js may write errors straight to stderr; keep those too.
const origStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  try {
    fs.appendFileSync(errLog, `[${new Date().toISOString()}] ${String(chunk).replace(/postgres(ql)?:\/\/[^\s"']+/g, "postgresql://***")}`);
  } catch {}
  return origStderr(chunk, ...rest);
};
process.on("uncaughtException", (e) => console.error("uncaught:", e));
process.on("unhandledRejection", (e) => console.error("unhandled:", e));

const next = require(require.resolve("next", { paths: [dir] }));
const app = next({ dev: false, dir });
const handle = app.getRequestHandler();
const port = process.env.PORT || 3000;

// ---- Background scheduler (Companies House auto-updates) -----------------------------------------------------------------
// The hosting login has no Scheduled Tasks, so the website starts the scheduler supervisor itself, and checks again every
// 5 minutes in case it died. The supervisor holds a lock file and the scheduler a database lease, so extra launches exit at
// once and there is never more than one. It only runs while the website process is alive (IIS may stop an idle site); jobs are
// resumable, so work continues on the next start. Turn off with SCHEDULER_FROM_WEB=0, or stop gracefully by creating
// tmp-ingest\production-scheduler.stop.
const { spawn } = require("child_process");
const supervisor = path.join(dir, "scripts", "run-production-scheduler.ps1");

function startScheduler() {
  if (process.env.SCHEDULER_FROM_WEB === "0" || !fs.existsSync(supervisor)) return;
  if (fs.existsSync(path.join(dir, "tmp-ingest", "production-scheduler.stop"))) return;
  const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "") };
  for (const k of Object.keys(env)) if (k === "PORT" || k.startsWith("IISNODE")) delete env[k];
  // os.userInfo() fails under the IIS account and crashes tsx; this preload gives it a fallback.
  const fix = path.join(dir, "scripts", "userinfo-fix.cjs");
  if (fs.existsSync(fix)) env.NODE_OPTIONS = `--require "${fix.replace(/\\/g, "/")}"`; // NODE_OPTIONS eats backslashes
  // Not detached: IIS runs the site inside a Windows job that forbids breaking away, so a detached launch fails silently.
  // The child lives as long as the website process; the 5-minute check restarts it after a recycle.
  const note = (m) => {
    try {
      fs.mkdirSync(path.join(dir, "tmp-ingest", "logs"), { recursive: true });
      fs.appendFileSync(path.join(dir, "tmp-ingest", "logs", "web-launch.log"), `[${new Date().toISOString()}] ${m}\n`);
    } catch {}
  };
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", supervisor], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // PowerShell's own errors (before the supervisor can write its log) go to web-launch.log.
    const keep = (d) => String(d).trim() && note("ps: " + String(d).trim().slice(0, 2000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => note("launch failed: " + e.message));
    child.on("exit", (c) => note("supervisor exited with code " + c));
    child.unref();
    note("supervisor launched (pid " + child.pid + ")");
  } catch (e) {
    note("launch failed: " + e.message);
  }
}

app
  .prepare()
  .then(() => {
    http.createServer((req, res) => handle(req, res)).listen(port, () => {
      console.log(`DIRECTOR.LTD ready (${path.basename(dir)}) on ${port}`);
    });
    startScheduler();
    setInterval(startScheduler, 5 * 60 * 1000).unref();
  })
  .catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
