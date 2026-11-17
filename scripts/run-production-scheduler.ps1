# Production scheduler supervisor for WINDOWS servers. Keeps scripts/scheduler.ts running and restarts it if it exits or crashes.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File <REPO_ROOT>\scripts\run-production-scheduler.ps1
#
# Run it from a Windows Scheduled Task (trigger: at start-up AND repeat every 5-15 minutes; the single-instance lock below makes a second
# launch exit at once), or from Plesk "Scheduled Tasks" if your Plesk offers a "run a command" task type.
#
# What it does
#   - works from the REPOSITORY ROOT (the folder that contains scripts\, src\ and node_modules\), never from .next\standalone;
#   - checks node and tsx are available, then starts:  node node_modules\tsx\dist\cli.mjs scripts\scheduler.ts
#   - configuration comes from the process environment first and <REPO_ROOT>\.env second (scripts\load-env.ts). Nothing is printed
#     from either; the log holds only what the scheduler itself logs (no secrets);
#   - single instance: an exclusive lock file stops a second supervisor; the scheduler also holds a database lease, so even a second
#     machine pointed at the same database cannot run the same jobs;
#   - restart policy by exit code:  0 / other -> 15 s;  2 (database guard refused: fix the .env) -> 5 min;  3 (another scheduler owns the
#     jobs) -> 2 min;
#   - graceful stop:  create the stop file (see -StopFile), wait up to a minute: the scheduler finishes its current request, saves its
#     checkpoint and exits, and this supervisor then exits too. Delete the stop file before starting again.
param(
  [string]$LogDir = $(if ($env:SCHEDULER_LOG_DIR) { $env:SCHEDULER_LOG_DIR } else { "" }),
  [string]$StopFile = "",
  [int]$MaxLogMegabytes = 20
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

if (-not $LogDir) { $LogDir = Join-Path $repo "tmp-ingest\logs" }
if (-not $StopFile) { $StopFile = Join-Path $repo "tmp-ingest\production-scheduler.stop" }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StopFile) | Out-Null
$log = Join-Path $LogDir "scheduler.log"
$lockPath = Join-Path $LogDir "scheduler.supervisor.lock"

function Write-Log([string]$msg) {
  "[$([DateTime]::UtcNow.ToString('o'))] supervisor: $msg" | Out-File -Append -Encoding utf8 $log
}

# ---- single instance (exclusive lock file; released automatically if this process dies) --------------------------------------
try {
  $lock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
  exit 0   # another supervisor holds the lock: nothing to do
}

# ---- preflight (fail loudly, do not loop on a broken installation) ----------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
$tsx = Join-Path $repo "node_modules\tsx\dist\cli.mjs"
if (-not $node) { Write-Log "PREFLIGHT FAILED: node was not found on PATH for this user"; exit 1 }
if (-not (Test-Path $tsx)) { Write-Log "PREFLIGHT FAILED: node_modules\tsx is missing. Run 'npm ci' (WITH dev dependencies) in $repo, then 'npx prisma generate'"; exit 1 }
if (-not (Test-Path (Join-Path $repo "scripts\scheduler.ts"))) { Write-Log "PREFLIGHT FAILED: scripts\scheduler.ts not found under $repo (is this the repository root?)"; exit 1 }
if (-not $env:DATABASE_URL -and -not (Test-Path (Join-Path $repo ".env"))) { Write-Log "PREFLIGHT FAILED: DATABASE_URL is not set and $repo\.env does not exist"; exit 1 }
if (Test-Path (Join-Path $repo ".env.local")) { Write-Log "WARNING: .env.local exists in the repository root. The scheduler ignores it, but remove it from a server." }

$env:NODE_ENV = "production"
$env:SCHEDULER_STOP_FILE = $StopFile
if (-not $env:LOG_FORMAT) { $env:LOG_FORMAT = "json" }

function Rotate-Log {
  if ((Test-Path $log) -and ((Get-Item $log).Length -gt ($MaxLogMegabytes * 1MB))) {
    for ($i = 4; $i -ge 1; $i--) { if (Test-Path "$log.$i") { Move-Item -Force "$log.$i" "$log.$($i + 1)" } }
    Move-Item -Force $log "$log.1"
  }
}

while (-not (Test-Path $StopFile)) {
  Rotate-Log
  Write-Log "starting scheduler (repo $repo)"
  cmd /c "node `"$tsx`" scripts\scheduler.ts >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  $delay = 15
  if ($code -eq 2) { $delay = 300 } elseif ($code -eq 3) { $delay = 120 }
  Write-Log "scheduler exited (code $code); restarting in $delay s unless the stop file exists"
  for ($i = 0; $i -lt $delay -and -not (Test-Path $StopFile); $i++) { Start-Sleep -Seconds 1 }
}
Write-Log "stop file found, exiting"
$lock.Close()
