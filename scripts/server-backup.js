// Backs up the database the live site uses (DATABASE_URL) on the Windows/Plesk server.
//
// The site's Windows account cannot open the PostgreSQL install folder, so pg_dump is started BY the database server
// itself (COPY ... FROM PROGRAM, allowed because the site connects as a superuser). It runs in the background.
//
// Plesk -> Node.js -> Run Node.js commands (npm only), after:  pkg set scripts.backup="node backup.js"
//   run backup -- start     starts the backup (large DB: 10-60 min)
//   run backup -- status    progress; when finished, verifies the file with pg_restore --list
//
// The dump holds real personal data. It is written outside the website folders. The password is never printed.
const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const STATE = path.join(__dirname, "backup-state.json");

function loadEnv() {
  for (const f of [".env", ".env.production", ".env.local"]) {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}

// A password with a raw "%" is not valid URL encoding; use it as written then.
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // PowerShell single-quoted string

// Runs a PowerShell script as the database server's Windows account and returns its output lines.
// -EncodedCommand avoids every quoting problem between SQL, cmd.exe and PowerShell.
async function runOnDbServer(p, script) {
  // Output goes back as plain ASCII "\n"-separated lines: Windows "\r\n" and non-UTF-8 bytes break COPY's reader.
  const wrapped = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$__o = & {",
    script,
    "} 2>&1 | ForEach-Object { (([string]$_) -replace '[\\r\\n]+', ' ') -replace '[^\\x20-\\x7E]', '?' }",
    '[Console]::Out.Write((@($__o) -join "`n") + "`n")',
  ].join("\n");
  const b64 = Buffer.from(wrapped, "utf16le").toString("base64");
  const cmd = `powershell -NoProfile -NonInteractive -EncodedCommand ${b64}`;
  return p.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`create temp table if not exists _bk_out (line text) on commit drop`);
      await tx.$executeRawUnsafe(`copy _bk_out from program '${cmd}' with (format csv, delimiter E'\\x01', quote E'\\x02')`); // csv keeps backslashes in paths
      const rows = await tx.$queryRawUnsafe(`select line from _bk_out`);
      return rows.map((r) => r.line);
    },
    { timeout: 90000, maxWait: 20000 },
  );
}

// Where PostgreSQL is installed, and the folders a backup may be written to (first writable one wins).
async function locate(p) {
  const dataDir = (await p.$queryRawUnsafe(`select setting from pg_settings where name='data_directory'`))[0].setting.replace(/\//g, "\\");
  const install = path.win32.dirname(dataDir);
  const dirs = ["E:\\pg_backups", path.win32.join(install, "backups"), path.win32.join(dataDir, "pg_backups")];
  return { install, dirs, dirList: "@(" + dirs.map(psq).join(", ") + ")" };
}

// pgpass format: backslash and colon must be escaped.
const pgpassField = (s) => String(s).replace(/\\/g, "\\\\").replace(/:/g, "\\:");

async function start(p) {
  const { install, dirList } = await locate(p);
  const u = new URL(process.env.DATABASE_URL);
  const db = safeDecode(u.pathname.slice(1));
  const user = safeDecode(u.username);
  const port = u.port || "5432";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const pgpassLine = [u.hostname, port, db, user, safeDecode(u.password)].map(pgpassField).join(":");

  // The backup runs from a small .bat started through WMI, so it is fully detached and this command returns at once.
  // The password goes only into a pgpass file in the backup folder, which the .bat deletes when pg_dump ends.
  const script = `
$ErrorActionPreference = 'Stop'
if (Get-Process pg_dump -ErrorAction SilentlyContinue) { 'ERROR|A backup (pg_dump) is already running. Use: run backup -- status'; return }
$dump = Join-Path ${psq(install)} 'bin\\pg_dump.exe'
if (-not (Test-Path $dump)) { 'ERROR|pg_dump.exe not found at ' + $dump; return }
$dir = $null
foreach ($d in ${dirList}) {
  try { New-Item -ItemType Directory -Force -Path $d | Out-Null; Set-Content -Path (Join-Path $d 'write-test.txt') -Value 'ok'; Remove-Item (Join-Path $d 'write-test.txt'); $dir = $d; break } catch {}
}
if (-not $dir) { 'ERROR|no folder the database server can write to'; return }
$base = Join-Path $dir ${psq(db + "_" + stamp)}
$file = $base + '.dump'; $log = $base + '.log'; $code = $base + '.exitcode'
$pass = Join-Path $dir 'pgpass.conf'
$bat  = Join-Path $dir 'run-backup.bat'
[IO.File]::WriteAllText($pass, ${psq(pgpassLine)} + [Environment]::NewLine, [Text.Encoding]::ASCII)
$lines = @(
  '@echo off',
  ('set "PGPASSFILE=' + $pass + '"'),
  ('"' + $dump + '" -h ${u.hostname} -p ${port} -U "${user}" -Fc -Z6 --no-owner --no-privileges -f "' + $file + '" "${db}" 2> "' + $log + '"'),
  ('> "' + $code + '" echo %ERRORLEVEL%'),
  ('del "' + $pass + '"')
)
[IO.File]::WriteAllLines($bat, $lines, [Text.Encoding]::ASCII)
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('cmd.exe /c ""' + $bat + '""') }
if ($r.ReturnValue -ne 0) { 'ERROR|could not start the backup (code ' + $r.ReturnValue + ')'; return }
'STARTED|' + $file
`;
  const out = await runOnDbServer(p, script);
  const line = out.find((l) => /^(STARTED|ERROR)\|/.test(l)) || out.join(" ");
  if (!line.startsWith("STARTED|")) return console.log("FAILED: " + line.replace(/^ERROR\|/, ""));
  fs.writeFileSync(STATE, JSON.stringify({ file: line.slice(8), db, started: new Date().toISOString() }, null, 2));
  console.log(`Backup STARTED for database ${db}`);
  console.log(`File: ${line.slice(8)}`);
  console.log("Check in about 5 minutes with: run backup -- status");
}

// Works from the backup folders themselves, so it also finds a backup started by an earlier attempt.
async function status(p) {
  const { install, dirList } = await locate(p);
  const script = `
$procs = @(Get-Process pg_dump -ErrorAction SilentlyContinue)
$latest = foreach ($d in ${dirList}) { if (Test-Path $d) { Get-ChildItem -Path $d -Filter '*.dump' -ErrorAction SilentlyContinue } }
$latest = $latest | Sort-Object LastWriteTime -Descending | Select-Object -First 1
'PROCS|' + $procs.Count
if (-not $latest) { 'NOFILE|'; return }
$base = $latest.FullName -replace '\\.dump$', ''
'FILE|' + $latest.FullName + '|' + $latest.Length + '|' + [int]((Get-Date) - $latest.CreationTime).TotalMinutes + '|' + [int]((Get-Date) - $latest.LastWriteTime).TotalMinutes
if (Test-Path ($base + '.exitcode')) { 'CODE|' + (Get-Content ($base + '.exitcode') -Raw).Trim() }
if ($procs.Count -gt 0) { return }
if (Test-Path ($base + '.log')) { Get-Content ($base + '.log') -Tail 15 | ForEach-Object { 'LOG|' + $_ } }
$restore = Join-Path ${psq(install)} 'bin\\pg_restore.exe'
$toc = & $restore --list $latest.FullName 2>&1
'EXIT|' + $LASTEXITCODE
'ENTRIES|' + @($toc | Where-Object { $_ -and -not $_.ToString().StartsWith(';') }).Count
foreach ($t in 'Company','Director','User') { 'TABLE|' + $t + '|' + [bool]($toc | Select-String -Pattern ('TABLE DATA public "?' + $t + '"? ') -CaseSensitive) }
`;
  const out = await runOnDbServer(p, script);
  const get = (k) => out.filter((l) => l.startsWith(k + "|")).map((l) => l.slice(k.length + 1));
  const procs = Number(get("PROCS")[0] || 0);
  if (get("NOFILE").length) return console.log(procs ? "pg_dump is running but no file yet. Check again in 5 minutes." : "No backup found. Use: run backup -- start");
  const [file, size, age, idle] = (get("FILE")[0] || "").split("|");
  const mb = (Number(size) / 1048576).toFixed(1) + " MB";
  if (procs > 0) return console.log(`RUNNING (started ${age} min ago). File so far: ${mb}. Check again in 5 minutes.\nFile: ${file}`);
  const logs = get("LOG").filter((l) => l.trim());
  if (logs.length) console.log("pg_dump messages:\n  " + logs.join("\n  "));
  const code = get("CODE")[0];
  const tables = Object.fromEntries(get("TABLE").map((l) => l.split("|")));
  // No exit-code file = started by an older version of this script; the pg_restore check below still applies.
  const ok = get("EXIT")[0] === "0" && (code === undefined || code === "0") && ["Company", "Director", "User"].every((t) => tables[t] === "True");
  console.log(ok ? "DONE and VERIFIED" : "FINISHED BUT NOT VERIFIED (send this to Claude)");
  console.log(`File: ${file}`);
  console.log(`Size: ${mb} | started ${age} min ago | pg_dump exit code: ${code ?? "unknown"} | archive entries: ${get("ENTRIES")[0]}`);
  console.log(`Company data: ${tables.Company} | Director data: ${tables.Director} | User data: ${tables.User}`);
}

loadEnv();
if (!process.env.DATABASE_URL) {
  console.log("ERROR: DATABASE_URL not found");
  process.exit(1);
}
const cmd = process.argv[2];
const p = new PrismaClient();
(cmd === "start" ? start(p) : cmd === "status" ? status(p) : Promise.resolve(console.log("Use: run backup -- start   or   run backup -- status")))
  .catch((e) => console.log("ERROR: " + e.message))
  .finally(() => p.$disconnect());
