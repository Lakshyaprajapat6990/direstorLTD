# DIRECTOR.LTD — Production scheduler: server administrator guide

For the person configuring the production server (Simon). The server's **operating system is not assumed** by this guide: it names the
Windows script (`.ps1`), the shell script (`.sh`) and an operating-system-neutral one-shot command, and you use whichever fits the server.

## 0. Who does what

| Already done in the code (developer) | Done on the server (administrator) |
|---|---|
| The scheduler, every job, recovery, single-instance lease, heartbeat, database host guard | Confirm the server operating system and Node version |
| Supervisor scripts `scripts/run-production-scheduler.ps1` and `.sh`, and a one-shot mode | Set the production environment (section 3) |
| `/api/health`, dashboard freshness and `npm run jobs:status` | Start the scheduler at boot and keep it running (section 5) |
| Tests against a scratch database and a local stand-in for Companies House | Check the first runs (section 6) |
| This guide, `.env.example` | Anything specific to Plesk or the host |

The website's start-up (Plesk application root, `start.js`) is **not changed** by this release; see section 9.

## 1. What runs automatically

The scheduler is **one separate Node.js process** that runs from the **repository root** (the folder containing `scripts/`, `src/` and
`node_modules/`), never from `.next/standalone`. It uses the same production PostgreSQL database as the website.

| Job | Schedule | Switch (default) |
|---|---|---|
| New registrations | every 6 h; resumes from the last covered day, re-reads a 2-day overlap, retries failed days; a day above 5,000 results is split by status/type and its total is proven or the day is **not** covered; a day with **no** registrations is accepted only when it is at least 3 days old **and** the preceding week returns data (Companies House really has empty days, e.g. 13–14 June 2026), otherwise it is retried, never skipped | on when `COMPANIES_HOUSE_API_KEY` is set; `NEW_REGISTRATIONS_ENABLED=0` turns it off |
| Dissolved companies | once per UTC day after 04:00 UTC; companies dissolved since the last success (3-day overlap; first run looks back 30 days; never more than 120); the importer also looks ahead for future cessation dates | **off** until `DISSOLVED_REFRESH_ENABLED=1` |
| Status reconcile (liquidation, administration) | every 7 days per status | **off** until `STATUS_RECONCILE_ENABLED=1` |
| Daily maintenance (overdue flags, pending DS01 events, officer queueing, report refresh) | 03:00 UTC, once per UTC day, retried every 30 min up to 5 times; **imports no company data** | on; `DAILY_MAX_ATTEMPTS=0` turns it off |
| Monthly bulk CSV | from day 3 of each month, 04:00 UTC onward it checks hourly and loads **only when a newer published file exists** than the snapshot already loaded (a restart never reloads a file); an interrupted load resumes from its checkpoint, and if it cannot be resumed (a different file) a fresh load starts | **off** until `MONTHLY_INGEST_ENABLED=1` |
| Officer / director processing | continuous; queued work first (new registrations, followed/saved/report companies, refreshes), then the background crawl; covers **every company status**: a live lane (active first, then liquidation, administration, receivership, ...) and a **dissolved lane**, taking turns by `OFFICER_CRAWL_DISSOLVED_PERCENT` (default 40% dissolved); each company is fetched once and a dissolved company is never re-fetched; bounded by `OFFICER_DAILY_REQUEST_CAP` and the shared quota gate; failed jobs retry with back-off; a dead worker's jobs return to the queue after the 5-minute lease | **off** until `OFFICER_WORKER_ENABLED=1`; the crawl of existing companies needs `OFFICER_CRAWL_ENABLED=1` too |
| Filing stream (optional) | persistent mode only; Companies House allows **one** stream connection per key | **off** until `STREAM_WORKER_ENABLED=1` |

Honest limits: the monthly file is monthly, so most company fields refresh monthly, not daily (new companies and dissolutions are daily).
Directors are processed progressively within the API quota; a full 14-million-company pass does not happen in one day.

## 2. Server prerequisites

- **Node 20.12 or newer** (the scheduler loads `.env` with `process.loadEnvFile`; on an older Node the `.env` is silently not read and the scheduler refuses to start). Confirm with `node -v`.
- The production PostgreSQL database, reachable from the machine that runs the scheduler.
- Outbound HTTPS to Companies House (`api.company-information.service.gov.uk`, and `download.companieshouse.gov.uk` if the monthly file is enabled).
- Disk for the monthly file cache (about 0.5 GB download, written under `tmp-ingest/` unless `INGEST_DOWNLOAD_DIR` says otherwise).

## 3. Install and build (after pulling the code)

```
cd <REPO_ROOT>
npm ci                      # WITH dev dependencies: the scheduler runs through tsx (a devDependency; see section 10)
npx prisma generate
npx prisma migrate deploy   # REQUIRED: this release adds one table (DissolvedSample, migration 20261116220000_dissolved_sample; additive, nothing existing is altered)
npm run build               # the WEBSITE: this release also changes /api/health and the staff dashboard, so rebuild it
```

`npm run build` is the default Turbopack build. (A previous out-of-memory failure on a developer machine was caused by
`src/lib/avatar.ts` making Turbopack trace the whole project folder, which held tens of GB of backups; fixed with `turbopackIgnore`
hints. No special flag is needed.)

## 4. Environment

Real process environment variables win over `<REPO_ROOT>/.env`. The scheduler reads **only** `<REPO_ROOT>/.env` (never `.env.local` or
`.env.production*`, so a stray developer file cannot redirect it). Do not leave `.env.local` on the server. Secrets are never logged.
Every variable below (and its default) is also in `.env.example`; a test keeps the two in step.

**Required for production**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | The production database the scheduler writes to. |
| `COMPANIES_HOUSE_API_KEY` | REST key. **Use a dedicated production key**: quota accounting lives in each database, so a key shared with a developer machine is rationed by two independent gates and nothing in code can stop the two from exhausting it together. |
| `NODE_ENV=production` | Turns on the database guard. The supervisor scripts set it themselves; `npm run jobs:once` and `npm run jobs:scheduler` do **not**, so put it in `.env` or the task environment. |
| `SCHEDULER_EXPECTED_DB_HOST`, `SCHEDULER_EXPECTED_DB_NAME` | Host and database name exactly as they appear in `DATABASE_URL`. In production the scheduler **refuses to start (exit code 2, writes nothing)** unless both are set and match. |

**Website side (the Plesk application's environment, not the scheduler's):** `SCHEDULER_EXPECTED=1` makes `/api/health` and the staff
dashboard report "scheduler never started"; without it the site can only report a scheduler that has run at least once.

**Recommended**

| Variable | Default | Purpose |
|---|---|---|
| `DISSOLVED_REFRESH_ENABLED` | off | `1` = daily dissolved-company refresh |
| `STATUS_RECONCILE_ENABLED` | off | `1` = weekly status reconcile (`STATUS_RECONCILE_STATUSES`, default `liquidation,administration`; `STATUS_RECONCILE_INTERVAL_DAYS`, default 7) |
| `MONTHLY_INGEST_ENABLED` | off | `1` = monthly bulk file (`MONTHLY_INGEST_DAY` 3, `MONTHLY_INGEST_UTC_HOUR` 4) |
| `OFFICER_WORKER_ENABLED` | off | `1` = officer worker (queued work) |
| `OFFICER_CRAWL_ENABLED` | off | `1` = also crawl existing companies progressively (needs the worker) |
| `OFFICER_DAILY_REQUEST_CAP` | 10000 | officer requests per UTC day (`0` = no cap); the quota gate still applies. **The production value is set here, not inherited from any developer machine.** |
| `OFFICER_CRAWL_DISSOLVED_PERCENT` | 40 | share of the crawl given to dissolved companies (`0` = off, max `100`); divides the same request budget, never raises it |
| `LOG_FORMAT` | `json` under the supervisors | `json` or `text` |

**Tuning (leave unless there is a reason)**

| Variable | Default | Purpose |
|---|---|---|
| `NEW_REGISTRATIONS_INTERVAL_HOURS` | 6 | registrations cadence |
| `DAILY_UPDATE_UTC_HOUR`, `DAILY_MAX_ATTEMPTS`, `DAILY_RETRY_MINUTES` | 3, 5, 30 | daily maintenance |
| `DISSOLVED_REFRESH_UTC_HOUR`, `DISSOLVED_REFRESH_MAX_ATTEMPTS`, `DISSOLVED_REFRESH_RETRY_MINUTES` | 4, 4, 60 | dissolved refresh |
| `CH_QUOTA_LIMIT`, `CH_QUOTA_WINDOW_SECONDS` | 600, 300 | Companies House allowance per window (all jobs share it) |
| `OFFICER_LEASE_MINUTES`, `OFFICER_MAX_ATTEMPTS`, `OFFICER_WORKER_BATCH`, `OFFICER_STALE_AFTER_DAYS` | 5, 6, 25, 180 | officer queue |
| `SCHEDULER_SHUTDOWN_GRACE_SECONDS` | 60 | time allowed to finish and save a checkpoint when stopping |
| `ONCE_OFFICER_MINUTES` | 50 | minutes the officer worker may run in one `jobs:once` pass |
| `STREAM_WORKER_ENABLED` | off | optional filing stream (needs `COMPANIES_HOUSE_STREAM_KEY`) |

## 5. Start it and keep it running

Pick what matches the server. The scheduler itself does not care which; the database lease means that even if two launchers fire at
once, only one scheduler owns the jobs (the other exits with code 3 and is retried later).

**A. PowerShell supervisor** (any Windows host; start at boot **and** every 5–15 minutes, a second launch exits at once):
```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <REPO_ROOT>\scripts\run-production-scheduler.ps1
```

**B. Shell supervisor** (any host with `bash` and `flock`, which comes with util-linux; start at boot **and** every 5 minutes, a second launch exits at once):
```
bash <REPO_ROOT>/scripts/run-production-scheduler.sh
```

Both: work from the repository root, set `NODE_ENV=production`, restart the scheduler after a crash, back off by exit code (15 s
normally, 2 min if another instance owns the jobs, 5 min if the database guard refused), log to `<REPO_ROOT>/tmp-ingest/logs/scheduler.log`
(JSON, rotated at 20 MB), and stop gracefully when the stop file `<REPO_ROOT>/tmp-ingest/production-scheduler.stop` exists.

**C. One-shot, no persistent process** (any scheduled-task facility, every 30–60 minutes; one pass over every due job, then exit):
```
cd <REPO_ROOT> && npm run jobs:once
```
Add `-- --with-monthly` to include the monthly bulk file in that pass. The officer worker runs for at most `ONCE_OFFICER_MINUTES`.
Do not run this alongside a persistent supervisor for the same jobs.

Exit codes: `0` finished or stopped cleanly, `1` unexpected error, `2` database guard refused (fix the environment), `3` another scheduler owns these jobs.

## 6. Check the first runs

1. `npm run jobs:status` — prints the database it is connected to, the scheduler heartbeat and each job's last success or failure. The host and database shown must be the production ones.
2. Sign in as a Super Admin and open `/api/health` — `status` should be `ok`; `jobs.reasons` lists anything that needs attention (table below). The staff dashboard shows the same facts separately for registrations, dissolved, director activity and scheduler.
3. Within about 6 hours: a `new_registrations` run with status `success` and a `coveredThrough` near today. On a first run it starts from the loaded bulk snapshot date (or 30 days back) and never more than 120 days; anything older is recovered by the monthly file.
4. After 04:00 UTC: the dissolved refresh (if enabled). Within minutes of the worker starting: officer activity (if enabled).

`/api/health` reasons: `scheduler_down` (no heartbeat for 5 min), `scheduler_never_started` (only with `SCHEDULER_EXPECTED=1`),
`registrations_stale` (more than 3 days behind), `dissolved_refresh_overdue` and `daily_update_overdue` (no success for 36 h while the
scheduler owns that job), `stalled_jobs`, `pending_ds01_events`, `stream_not_running`, `stream_silent`.

## 7. Stop, deploy, restart

- Graceful stop: create `<REPO_ROOT>/tmp-ingest/production-scheduler.stop`. Within about a minute the scheduler finishes its current request, saves its checkpoint and exits, then the supervisor exits. **Delete the file to allow starting again.**
- Deploying: stop the scheduler, pull, install and build, start it again. It resumes from checkpoints; nothing restarts from zero.
- A crashed scheduler's lease is taken over by its replacement after 2 minutes without a heartbeat.

## 8. Safety built in

One scheduler per job per database (a database lease plus a 30-second heartbeat); the database host guard; every Companies House
request goes through the shared quota gate (429 cool-downs, circuit breakers); a failed batch never advances its checkpoint; an
incomplete run is recorded as failed or partial, never as a success; existing users, sessions, CRM data, reports and notes are never
touched by these jobs.

## 9. Website start-up (unchanged by this release)

Plesk is reported to use application root `/httpdocs/.next/standalone` with startup file `start.js` (taken from screenshots; this
repository cannot confirm it). The repository contains neither a `start.js` nor `output: "standalone"` in `next.config.ts`, so that file
lives only on the server. Next.js **cleans the `.next` folder on every build**, so after each `npm run build` confirm that
`.next/standalone/start.js` (and whatever it needs) is still in place before restarting the site, and keep a copy outside `.next`.
The scheduler does not depend on any of this.

## 10. Why `tsx` is not moved to `dependencies`

The supervisors run `node node_modules/tsx/dist/cli.mjs scripts/scheduler.ts`. `npm ci` installs devDependencies by default, so no
dependency change is needed. If the server installs with `npm ci --omit=dev`, run `npm i --no-save tsx` there instead of editing `package.json`.

## 11. Minimum production environment for FULL automation

Every job is OFF until its switch is set. With only the required variables the website works but **no director data, dissolved refresh,
status reconcile or monthly file is processed**. For the full automatic behaviour set, in `<REPO_ROOT>/.env` (or the task environment):

```
NODE_ENV=production
DATABASE_URL=...                       SCHEDULER_EXPECTED_DB_HOST=...   SCHEDULER_EXPECTED_DB_NAME=...
COMPANIES_HOUSE_API_KEY=...            # a DEDICATED production key
OFFICER_WORKER_ENABLED=1               OFFICER_CRAWL_ENABLED=1
OFFICER_DAILY_REQUEST_CAP=...          # the production daily request budget (the code default is 10000)
DISSOLVED_REFRESH_ENABLED=1            STATUS_RECONCILE_ENABLED=1        MONTHLY_INGEST_ENABLED=1
```

The website's own environment additionally needs `DATABASE_URL`, `AUTH_SECRET` (32+ random characters), `APP_BASE_URL` / `NEXTAUTH_URL`,
`TOKEN_ENCRYPTION_KEY`, the SMTP settings and `COMPANIES_HOUSE_API_KEY` (the site fetches a company's officers on demand), plus
`SCHEDULER_EXPECTED=1` so a scheduler that never started is reported. One scheduler process runs **all** the enabled jobs; the website
runs none of them. Status reconcile is weekly per status (not daily); the registrations, dissolved refresh, daily maintenance and the
officer worker are daily or continuous as listed in section 1.

## 12. Director-data estimate: the dissolved random sample

The staff dashboard's "Estimated Total Director Data" and "Estimated Time to Complete" need a random sample of dissolved companies
(150 per dissolution year, about 2,700 Companies House requests). Without it they show "Not yet available" (safe: no figure is invented).
It is NOT created by the scheduler. On a database that has not had it, an authorised person runs, from `<REPO_ROOT>`:

```
npm run jobs:dissolved-sample -- draw                                  # chooses the sample (writes only DissolvedSample rows, no API call)
npm run jobs:dissolved-sample -- run --max-requests 3000 --cap <OFFICER_DAILY_REQUEST_CAP>   # LIVE requests, controlled batches; repeat until it reports "done"
npm run jobs:dissolved-sample -- status                                # read-only: per-year sample sizes and the estimate
```

`run` stops before the daily cap (with a reserve), after the request budget, and on any 429 / breaker / quota hand-back; run it again later.
The estimate is sampling-based: `status` prints each year's sample, population and range. Estimated records are appointment records, not people.

## 12b. Build fails with a React "Invalid hook call" / `useContext` error on `/_global-error`

**Cause: the Node version, not React.** Next.js 16 requires Node >= 20.9; on an older Node the build dies inside React while
prerendering `/_global-error`, reporting `Invalid hook call` or `Cannot read properties of null (reading 'useContext')`. The
error names React, so it reads like a dependency problem, and swapping React versions or deleting `node_modules` does not
help. There is no `global-error.tsx` in this project - that route is Next.js's own default - so nothing in this repository
can be edited to fix it.

`npm run build` now refuses to start on a Node below **20.12** (`scripts/check-node.js`) and prints the version it found and
where to change it, so this fails with a clear message instead of a React stack trace. The floor is 20.12 rather than 20.9
because the scheduler needs `process.loadEnvFile` (section 2).

On Plesk: **Websites & Domains > the domain > Node.js > Node.js version**, choose 20.12 or newer (22 LTS preferred), then run
**NPM install** again so the native modules are rebuilt against that version. Confirm with `node -v` in the domain's shell;
Plesk can have several Node versions installed, and the one in the panel is not always the one on the SSH `PATH`.

## 13. `npm run build` sometimes exits 1 although it compiled

Next.js 16.4.2 ships a built-in upgrade check (`experimental.agentUpgrade`, default `security`). When the build is started by an AI coding
agent (an `AI_AGENT`-type variable in the environment) and the installed version has a published advisory, the **first** `next build` stops with
"SecurityFatalError ... upgrade" (exit 1) and leaves a retry receipt in `.next/cache`; the same command within 5 minutes continues (exit 0).
A build started by a person in an ordinary shell, or in CI, is not affected. The advisory is real: `npm audit` reports Next.js 16.3.0 -
16.4.4 (moderate: information disclosure across root params when a 'use cache' function is called through `unstable_cache()`), plus qs
(moderate) and zod (high); fixed versions exist (next 16.4.5 and later). The proper resolution is a dependency upgrade, which is the owner's
decision. The check has deliberately NOT been disabled.

## 14. Serverless hosting (Vercel): background jobs without the scheduler

On a host where nothing stays resident between requests there is no process to run `npm run jobs:scheduler` in. The jobs are then
driven by the platform's cron, which calls `GET /api/cron/<job>` on a timetable kept in `vercel.json`. Each path calls the **same
function** the scheduler calls, so there is one implementation of the work.

| Cron path | Default schedule (UTC) | Replaces |
|---|---|---|
| `/api/cron/daily-update` | `15 3 * * *` | Daily maintenance |
| `/api/cron/new-registrations` | `0 */6 * * *` | New registrations |
| `/api/cron/dissolved-refresh` | `30 4 * * *` | Dissolved companies **and** the status reconcile (each runs only when the database says it is due) |
| `/api/cron/officer-worker` | `*/10 * * * *` | Officer / director processing, in ~4-minute slices; what is left stays queued for the next call |
| `/api/cron/reconcile` | `*/30 * * * *` | Marks jobs whose worker was killed mid-run as failed, so health does not report a dead job as live |

The per-job switches in section 1 and 3 still apply: a job whose `*_ENABLED` variable is off reports `skipped` and does nothing, and
every job reports `skipped` when `COMPANIES_HOUSE_API_KEY` is absent.

**Authorisation.** Set `CRON_SECRET` (32+ random characters) in the host's environment. The platform sends it as
`Authorization: Bearer <value>`; every other request gets a plain `404`, and a bad secret and an unknown job are deliberately
indistinguishable. **Without `CRON_SECRET`, or with one under 16 characters, `/api/cron` refuses everything** - an unauthenticated job
runner is worse than none. Generate with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**Two jobs cannot run this way**, and a deployment that needs them still needs a machine running the real scheduler:

- the **filing stream**, which needs one persistent connection per key (section 1); and
- the **monthly bulk CSV**, which reads a multi-GB file, far past any function time limit.

Running the scheduler *and* these crons at the same time is safe: every job takes the same database lock, so whichever starts second is
refused with `JobAlreadyRunningError` and reports `skipped` rather than doing the work twice. It is merely wasteful.

**Function time limits.** `vercel.json` gives `/api/cron/*` 300 s and the other API routes 60 s (the platform's 10 s default is too short
for the exports and PDF generation). The officer worker stops itself at 4 minutes so it returns before the platform kills it; a job killed
mid-run leaves a `running` row, which `/api/cron/reconcile` then clears.

**Profile pictures.** These hosts have a read-only, throw-away filesystem, so pictures are stored in the database (table `UserAvatar`),
not on disk. A deployment that previously ran with pictures in `./data/avatars` brings them across once, after migrating:

```
npm run avatars:import              # copy, keeping anything already in the database
npm run avatars:import -- --prune   # and delete each file once it is safely in the database
```

## 15. What was verified before hand-over

All against a scratch database and a local stand-in for Companies House (no live Companies House request was made): the registration,
dissolved, status and monthly jobs; the officer worker running through the scheduler; the persistent loop; the lease, duplicate-instance
refusal, heartbeat and crash take-over; the database guard; health and freshness; and the Windows script running the real scheduler.
The shell script was exercised with a stand-in for `flock`; please check it on the real server, as with any supervisor on a new host.
