# Runs the scheduler for OFFICER DATA ONLY and restarts it if it exits or crashes.
#   powershell -File scripts/run-officer-scheduler.ps1 [-DailyCap 100000] [-KeepAwake:$false]
# What it enables:   the officer worker + the active-company crawl (queued work first: reports, followed/saved/red-flagged, filters).
# What it disables:  new-registration import, daily update (DAILY_MAX_ATTEMPTS=0), monthly bulk import, filing stream.
# Resume safety:     the queue, retry state, leases and the crawl cursor all live in the database, so a restart continues where
#                    the last run stopped; jobs left leased by a dead worker return to the queue after the 5-minute lease.
# Keep awake:        by default the script asks Windows not to enter idle sleep / Modern Standby while it runs (a sleeping laptop
#                    sends no requests at all and drops its network). It lasts only as long as this process; closing the lid or
#                    pressing the power button still sleeps the machine, and the worker simply resumes on wake.
# Stop:              create tmp-ingest/officer-worker.stop, then end the node processes. (Without the file the loop restarts them.)
param([int]$DailyCap = 100000, [bool]$KeepAwake = $true)

Set-Location (Split-Path -Parent $PSScriptRoot)

# Single instance: a second copy (e.g. the logon task firing while this is already running) exits at once instead of
# starting a second scheduler.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\DirectorLtdOfficerSupervisor", [ref]$createdNew)
if (-not $createdNew) { exit 0 }
$stop = "tmp-ingest/officer-worker.stop"
$log = "tmp-ingest/backup/scheduler-officer.log"

if ($KeepAwake) {
  Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
  [void][Win32.Power]::SetThreadExecutionState([Convert]::ToUInt32("80000001", 16))  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
}

$env:OFFICER_WORKER_ENABLED = "1"
$env:OFFICER_CRAWL_ENABLED = "1"
$env:NEW_REGISTRATIONS_ENABLED = "0"
$env:DAILY_MAX_ATTEMPTS = "0"
$env:OFFICER_DAILY_REQUEST_CAP = "$DailyCap"
# Explicit "0" (not just unset): a value in the environment or in .env can never switch these on from here.
$env:STREAM_WORKER_ENABLED = "0"
$env:MONTHLY_INGEST_ENABLED = "0"
$env:DISSOLVED_REFRESH_ENABLED = "0"  # the register refresh belongs to the registrations scheduler (scripts/run-registrations-scheduler.ps1)

while (-not (Test-Path $stop)) {
  "[$([DateTime]::UtcNow.ToString('o'))] supervisor: starting scheduler (daily request cap $DailyCap)" | Out-File -Append -Encoding utf8 $log
  cmd /c "npm run -s jobs:scheduler >> $log 2>&1"
  "[$([DateTime]::UtcNow.ToString('o'))] supervisor: scheduler exited (code $LASTEXITCODE); restarting in 15 s" | Out-File -Append -Encoding utf8 $log
  Start-Sleep -Seconds 15
}
"[$([DateTime]::UtcNow.ToString('o'))] supervisor: stop file found, exiting" | Out-File -Append -Encoding utf8 $log
