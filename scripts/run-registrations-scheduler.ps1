# Runs the scheduler for the NEW-REGISTRATIONS import ONLY and restarts it if it exits or crashes.
#   powershell -File scripts/run-registrations-scheduler.ps1
# What it enables:   (1) the daily dissolved-company REGISTER refresh (DISSOLVED_REFRESH_ENABLED=1; once per UTC day after 04:00), and
#                    (2) the new-registration sync (scripts/scheduler.ts, maybeRunNewRegistrations): every 6 hours it fetches the companies
#                    incorporated since the last fully covered day (2-day overlap), one Companies House request per day.
# What it disables:  the officer worker and crawl (they have their own supervisor, scripts/run-officer-scheduler.ps1, which is not
#                    touched by this one), the daily update, the monthly bulk import and the filing stream.
# Safe next to the officer supervisor: both talk to the same database, so a run is single-flight (a PostgreSQL advisory lock inside
#                    startRun) and the six-hour interval is read from the run table; every Companies House request goes through the
#                    SAME shared quota gate (class "backfill") as the officer worker.
# Resume safety:     the checkpoint (last fully stored day) lives in the database, so a restart or a missed run is recovered by the next one.
# Stop:              create tmp-ingest/registrations-scheduler.stop, then end the node processes. (Without the file the loop restarts them.)
Set-Location (Split-Path -Parent $PSScriptRoot)

# Single instance: a second copy (the logon / 15-minute task trigger firing while this is already running) exits at once.
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\DirectorLtdRegistrationsSupervisor", [ref]$createdNew)
if (-not $createdNew) { exit 0 }
$stop = "tmp-ingest/registrations-scheduler.stop"
$log = "tmp-ingest/backup/scheduler-registrations.log"

$env:NEW_REGISTRATIONS_ENABLED = "1"
$env:NEW_REGISTRATIONS_INTERVAL_HOURS = "6"
# Daily dissolved-company REGISTER refresh (companies that were struck off since the last run: advanced search by dissolution date, tens of
# requests, once per UTC day after 04:00). This is NOT the dissolved-company officer/director crawl, which is the officer worker's separate lane.
$env:DISSOLVED_REFRESH_ENABLED = "1"
$env:DISSOLVED_REFRESH_UTC_HOUR = "4"
# Explicit "0" (not just unset): a value in the environment or in .env can never switch these on from here.
$env:OFFICER_WORKER_ENABLED = "0"
$env:OFFICER_CRAWL_ENABLED = "0"
$env:DAILY_MAX_ATTEMPTS = "0"
$env:STREAM_WORKER_ENABLED = "0"
$env:MONTHLY_INGEST_ENABLED = "0"

while (-not (Test-Path $stop)) {
  "[$([DateTime]::UtcNow.ToString('o'))] supervisor: starting registrations scheduler" | Out-File -Append -Encoding utf8 $log
  cmd /c "npm run -s jobs:scheduler >> $log 2>&1"
  "[$([DateTime]::UtcNow.ToString('o'))] supervisor: scheduler exited (code $LASTEXITCODE); restarting in 15 s" | Out-File -Append -Encoding utf8 $log
  Start-Sleep -Seconds 15
}
"[$([DateTime]::UtcNow.ToString('o'))] supervisor: stop file found, exiting" | Out-File -Append -Encoding utf8 $log
