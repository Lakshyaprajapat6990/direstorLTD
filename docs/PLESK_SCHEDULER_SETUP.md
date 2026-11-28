# Plesk: background scheduler setup checklist

Short, Plesk-specific checklist for the client's requested automation. The full reference is
[PRODUCTION_SCHEDULER.md](PRODUCTION_SCHEDULER.md); section numbers below point into it.

Requested: registrations every 6 h, daily dissolved refresh, continuous officer processing, weekly reconciliation,
monthly ingestion — all in **one separate background scheduler process** (not the website).

`<REPO_ROOT>` = the folder Plesk pulled the Git repo into (contains `scripts/`, `src/`, `package.json`), **not** `.next/standalone`.

## 1. Fix the Node version first (previous `/_global-error` / `useContext` errors)

These errors come from Node being too old, not from React (section 12b).

1. Plesk > **Websites & Domains** > the domain > **Node.js** > **Node.js version**: choose **22 LTS** (minimum 20.12).
2. Click **NPM install** again.
3. In the domain's SSH shell: `node -v` must print v20.12+ (Plesk may have several Node versions; the shell `PATH` can differ
   from the panel — if so, use the full path, e.g. `/opt/plesk/node/22/bin/node`).

## 2. Database restore (1.61 GB PostgreSQL 18.6 backup)

Restore into the production PostgreSQL (18.x server — a PG 18 dump cannot be restored into an older server). Note the exact
host and database name; they go into `DATABASE_URL` and `SCHEDULER_EXPECTED_DB_*` below.

## 3. Install, migrate, build (from `<REPO_ROOT>`, SSH)

```
npm ci
npx prisma generate
npx prisma migrate status     # review what is pending BEFORE applying (back up first)
npx prisma migrate deploy
npm run build
```

After the build, confirm `.next/standalone/start.js` still exists (Next.js wipes `.next` on build; section 9).

## 4. `<REPO_ROOT>/.env` for the scheduler

```
NODE_ENV=production
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DBNAME?schema=public"
SCHEDULER_EXPECTED_DB_HOST=HOST          # exactly as in DATABASE_URL
SCHEDULER_EXPECTED_DB_NAME=DBNAME        # exactly as in DATABASE_URL
COMPANIES_HOUSE_API_KEY=...              # dedicated production key

# Registrations every 6 h: ON automatically once the API key is set
NEW_REGISTRATIONS_INTERVAL_HOURS=6
# Daily dissolved refresh (after 04:00 UTC)
DISSOLVED_REFRESH_ENABLED=1
# Continuous officer / director processing
OFFICER_WORKER_ENABLED=1
OFFICER_CRAWL_ENABLED=1
OFFICER_DAILY_REQUEST_CAP=10000
# Weekly reconciliation (liquidation, administration)
STATUS_RECONCILE_ENABLED=1
STATUS_RECONCILE_INTERVAL_DAYS=7
# Monthly bulk ingest (from day 3, 04:00 UTC)
MONTHLY_INGEST_ENABLED=1
LOG_FORMAT=json
```

Do not leave a `.env.local` on the server. The `.env` file must never be committed.

## 5. Website environment (Plesk > Node.js > Custom environment variables)

`DATABASE_URL`, `AUTH_SECRET` (32+ random chars), `NEXTAUTH_URL` and `APP_BASE_URL` (the real https address),
`TOKEN_ENCRYPTION_KEY`, SMTP / Resend settings, `COMPANIES_HOUSE_API_KEY`, and **`SCHEDULER_EXPECTED=1`**.
Restart the app.

## 6. Keep the scheduler running (Plesk > Tools & Settings > Scheduled Tasks, or the domain's Scheduled Tasks)

Linux host — add a **Run a command** task, every **5 minutes** (`*/5 * * * *`), as the domain's system user:

```
cd <REPO_ROOT> && bash scripts/run-production-scheduler.sh
```

Windows host — same, with:

```
powershell.exe -NoProfile -ExecutionPolicy Bypass -File <REPO_ROOT>\scripts\run-production-scheduler.ps1
```

The supervisor keeps one scheduler alive; repeated launches exit at once (lock + database lease), so the 5-minute task also
restarts it after a reboot or crash. If the Node on that task's `PATH` is too old, prepend it, e.g.
`export PATH=/opt/plesk/node/22/bin:$PATH && cd <REPO_ROOT> && bash scripts/run-production-scheduler.sh`.

Do **not** also add `npm run jobs:once` or Vercel crons for the same database.

## 7. Verify

1. `npm run jobs:status` — shows the production host/DB, a fresh heartbeat, and each job.
2. Log: `<REPO_ROOT>/tmp-ingest/logs/scheduler.log`.
3. As Super Admin open `/api/health` — `status: ok`.
4. Within 6 h: `new_registrations` success; after 04:00 UTC: dissolved refresh; within minutes: officer activity.

Stop gracefully: create `<REPO_ROOT>/tmp-ingest/production-scheduler.stop` (delete it to allow restarts). Deploy = stop, pull,
install, build, delete the stop file.
