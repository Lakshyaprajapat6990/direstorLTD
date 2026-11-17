# DIRECTOR.LTD

Companies House search, filtering, reporting and CRM platform.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind v4 · Prisma · **PostgreSQL** · custom session auth · real Companies House REST + streaming APIs · Google Calendar OAuth.

## Getting started (development)

```bash
npm install
npm run db:dev          # terminal 1: disposable local PostgreSQL on :5433 (no Docker needed), UTF-8
cp .env.example .env    # then fill AUTH_SECRET (see the file for the generator command)
npm run db:migrate      # apply migrations
npm run db:seed         # OPTIONAL: ~7,000 synthetic development companies + three dev users
npm run dev             # terminal 2 (regenerates the Prisma client first, so it always matches prisma/schema.prisma)
```

After pulling a change that touches `prisma/schema.prisma`: stop the dev server, run `npm run db:migrate`, then start it again.
On Windows a running dev server locks the Prisma engine file, so `prisma generate` cannot replace it while the server is up;
running it anyway leaves a half-updated client and the stale-client error `Unknown field ... for select statement`.

`db:seed` never prints or stores a known password: it generates random passwords for the three development
users (Super Admin / Admin / User) and writes them to `./.dev-credentials.local` (gitignored). Set
`SEED_PASSWORD` to choose one, or rotate any account later:

```bash
NEW_PASSWORD='a long unique passphrase' npm run user:set-password -- someone@example.com
npm run user:set-password -- someone@example.com --generate
```

**Production / first start:** do not seed. Create the first Super Admin with `npm run admin:bootstrap` (interactive, hidden password, shows the target database and asks for confirmation; refuses if a Super Admin already exists; creates no companies or demo data). Further users are created from the Users screen.

The seed refuses to run when `NODE_ENV=production`. There are no demo credentials anywhere in the UI or docs.

### Environment

See [.env.example](.env.example) for every variable. Required: `DATABASE_URL`, `AUTH_SECRET`. Real data needs
`COMPANIES_HOUSE_API_KEY` (REST) and `COMPANIES_HOUSE_STREAM_KEY` (filing stream). **Never commit or paste key values**;
keep them in `.env` (gitignored) or AWS Secrets Manager. In production the app refuses to start with a missing/short/placeholder `AUTH_SECRET`.

## Architecture

- `prisma/schema.prisma` + `prisma/migrations` — PostgreSQL schema. `Company`/`Director` hold Companies House data
  (`Company.source`: `seed` | `bulk_import` | `advanced_search` | `stream` | `rest_enrichment`). User/CRM data
  (`UserCompanyState`, `Note`, `FollowUp`, `CrmContact`, `Report`, `ActivityLog`) is separate. Date-only facts are SQL `DATE`.
  Hand-written performance objects (trigram GIN indexes for `ILIKE`, postcode prefix index, partial indexes for the
  DS01/dormant/late-filing filters) live in the initial migration.
- `src/lib/filters` — one registry of filterable fields (`fields.ts`), a **validator** (`validate.ts`: unknown fields,
  disallowed operators, NaN, impossible dates, oversized/deep trees are rejected with HTTP 400) and a compiler to Prisma
  (`compile.ts`). Every query goes through `buildCompanyWhere` (`src/lib/data/companies.ts`) so search, export, reports and
  the daily refresh can never disagree.
- `src/lib/companies-house` — the real integration: `client.ts` (auth, rate-limit awareness, 429/5xx retry), `csv/`
  (ZIP streaming, real dotted headers, DD/MM/YYYY parser, explicit category maps), `bulkIngest.ts`, `filingEvents.ts`
  (DS01/DS02), `streamWorker.ts`, `officers.ts`, `dailyUpdate.ts`.
- `src/lib/jobs` — run bookkeeping: heartbeats, stale-run reconciliation, success/partial/failed classification.
- `src/lib/calendar` — provider-agnostic calendar (internal fallback + Google; follow-ups are all-day events).
- `src/lib/auth` — password policy, login throttling, sessions.

## Security model

- **Sessions** are signed cookies, but every request re-checks the user row: a deactivated/deleted user is rejected at once and
  the role always comes from the database (a demotion applies on the next request).
- **Roles:** `USER` < `ADMIN` < `SUPER_ADMIN`. An Admin can only activate/deactivate plain Users; only a Super Admin changes roles or
  touches Admin/Super Admin accounts; nobody can deactivate/demote themselves. Enforced in the API, not the UI.
- **Login throttling** (DB-backed, shared by all instances): 8 failures / 15 min per account+IP, 40 per IP; generic error text; constant-time comparison for unknown accounts.
- **Passwords:** 12+ characters, no common/guessable passwords, must not contain the email name.
- **Headers:** CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (`next.config.ts`). No page can be framed except the Super Admin editor's own canvas (same origin); embeds are limited to YouTube and Vimeo. The CSP keeps `'unsafe-inline'` for scripts (Next.js hydration); move to nonces in `proxy.ts` if a stricter policy is required.
- **Export:** a `USER` must apply a filter or search term (no "export everything"); row caps per role (`EXPORT_MAX_ROWS_*`); every export is written to the activity log; CSV cells starting with `= + - @` are neutralised.
- Secrets live only in environment variables.

## Data semantics (decisions worth knowing)

- **Director count** (`directorCount`, "single director") counts *active* officers (no `resigned_on`) whose role is `director`, `corporate-director`, `nominee-director`, `corporate-nominee-director`, or — for LLPs — `llp-member`, `llp-designated-member`, `corporate-llp-member`, `corporate-llp-designated-member`. Secretaries, judicial factors and any other role are stored and shown but **not** counted. All officer pages are fetched (the API returns 35 per page by default). See `src/lib/companies-house/officers.ts`.
- **Manual CRM contacts** are private to the user who typed them, stored separately (`CrmContact`), and **never** change `directorCount` / `singleDirector` or any Companies House director filter.
- **DS01** = application to strike the company off. `hasDS01` is set when a DS01 filing event arrives on the stream (`ds01FiledAt`) or the register shows "Active – Proposal to Strike off". A DS02 (withdrawal) clears it. A monthly CSV re-import or profile refresh can never erase a DS01 recorded from an event.
- **Company age** uses calendar dates (UTC): a company incorporated on 2016-09-30 is exactly 10 on 2026-09-30, at any time of day.
- **Follow / Trash** are per user and mutually exclusive: trashing a followed company un-follows it; following a trashed company restores it.
- **Dormant** comes from the last accounts type (`DORMANT`), never from company status.
- **Seed vs real data:** every company carries its `source`. `SEED_DATA_VISIBLE` decides whether synthetic rows appear in search/reports/exports (default: visible in development, hidden in production). Dashboard, landing page and Settings state real coverage ("N of roughly 5.6 million").

## Website Content (CMS)

Super Admin → **Website Content (CMS)** is a visual editor for the public homepage: the real page is shown in the editor, you click
any text to edit it, formatting and added sections show immediately, and nothing is public until you publish.

- **Access:** `SUPER_ADMIN` only, checked on the server by every page and API (no permission key exists for it, so legacy Admin
  accounts cannot inherit it). The canvas (`/website-preview/editor`) and the draft preview (`/website-preview`) are guarded the same way.
- **What is editable:** the homepage wording, and its look. Text takes bold / italic / underline, a font from a short list, a pixel size
  (8–120), any text colour and highlight (a hex value from the colour picker, with recent colours, saved text/background pairs and a
  contrast check), alignment (left, centre, right, justified), line height, paragraph spacing, lists and validated links, on whole
  paragraphs or on selected words. **Buttons** have a label, a destination, new-tab, font, size, weight, colours, border, radius and padding,
  and **headings, sections and images** have their own appearance settings (image size with aspect lock, alignment, text wrap, fit,
  corners, border). *Added sections* (text, image, video, call to action, feature cards, FAQ) can be placed and **dragged into any
  position** with the other sections; text sections can also contain pictures between their paragraphs.
- **Order:** the section list on the overview panel (drag handle, or Up/Down buttons) writes an explicit `order` (a validated list of
  section keys, `src/lib/site-content/styles.ts`); the homepage renders from it. The hero stays first and the closing call to action last.
  *Reset order* removes it. Without a stored order the page is exactly the original design.
- **What stays code-controlled:** statistics, the API and ownership statements, the protected FAQ answers, filter fields, icons, and
  the destination of every **sign-in button** (these show a lock and the reason; their label and look stay editable). Colours, sizes,
  spacing and fonts are values from fixed lists or bounded ranges, never free CSS. Content is validated data
  (`src/lib/site-content/schema.ts`), never HTML; the renderer builds React elements and inline styles from validated values only.
- **Undo / redo** (Ctrl+Z / Ctrl+Y, and buttons) cover text, formatting, appearance, order and added/removed sections until the page is left.
- **Workflow:** draft → private preview → publish. Every publish and restore is a permanent, hashed revision (author snapshot, note).
  Restoring an old version publishes it again as a new one. Version-conflict checks stop two people overwriting each other.
- **Images** are stored in PostgreSQL (`SiteMedia`, JPEG/PNG/WebP up to 2 MB, type read from the bytes) and served by `/media/<id>`, which
  is public only while the *published* content refers to the image. Videos are YouTube / Vimeo embeds only (`frame-src` in `next.config.ts`).
- **Freshness:** the homepage is regenerated at most every 60 seconds and on every publish (`revalidatePath`). With several servers or a
  CDN a publish can take longer to appear everywhere; the editor says so.
- **Set up an existing database:** `npm run db:generate` (stop `npm run dev` first), `npm run db:migrate`, restart. Migrations only add
  tables (`SiteContent`, `SiteContentRevision`, `SiteMedia`); until they are applied the homepage keeps its built-in wording.

## Password recovery (email)

"Forgot password?" on the sign-in page emails a one-time link to the account's registered address. It works for every role
(customer, staff, Super Admin) and never changes a role, permission, status or team.

**How it behaves**

- **The link:** `<site>/reset-password#token=<secret>`. The secret is 256 random bits in the URL *fragment* (browsers never send it
  to a server, so it is absent from access logs and `Referer`); the page moves it into memory and clears the address bar. Only its
  SHA-256 hash is stored (`PasswordResetToken`). It expires after 30 minutes, works once, and a newer request replaces an older link.
- **The answer to a request** is identical whether or not the address is registered, and the lookup and email happen after the
  response is sent. The page therefore says "if that address belongs to an account, an email will arrive shortly": it cannot know
  whether the mail server accepted the message. If sending fails, the server logs `recovery.mail_failed` with the SMTP error code
  (never the token, address or link) and withdraws the token. Look for that line when users report missing emails.
- **Not configured:** without `SMTP_HOST`, `MAIL_FROM` and `APP_BASE_URL` (or `NEXTAUTH_URL`) the page and API say recovery is not set
  up. Nothing is sent and nothing is pretended.
- **Limits** (per 15 min, sharing the sign-in throttle table): 3 requests per address, 10 per IP (needs `TRUST_PROXY=1`), 60 overall;
  20 link attempts per IP, 200 overall.
- **A successful reset** stores the new password with the existing bcrypt setup, applies the same password policy as registration,
  spends the link in the same database transaction (simultaneous uses: exactly one wins) and ends the account's other sessions.

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SMTP_HOST` | yes | Mail server, e.g. `smtp.gmail.com` |
| `SMTP_PORT` | no | `587` (STARTTLS, default) or `465` (with `SMTP_SECURE=true`) |
| `SMTP_SECURE` | no | `true` only for port 465 (TLS from the first byte); `false` for 587 |
| `SMTP_USER`, `SMTP_PASS` | if the server needs a login | Mailbox login. Both or neither. For Google, `SMTP_PASS` is an **App Password** |
| `MAIL_FROM` | yes | Sender, e.g. `DIRECTOR.LTD <sender@your-domain>` |
| `APP_BASE_URL` | yes | The site's real address, e.g. `https://your-domain.example`. Used to build the emailed link; never taken from the request. Falls back to `NEXTAUTH_URL` |
| `SMTP_REQUIRE_TLS` | no | Default `true`: refuse a server that cannot upgrade to TLS. `false` only for local test listeners |

Secrets live only in environment variables (a gitignored `.env`, or the hosting panel). They are read on the server and never sent to the
browser or logged. The repository contains no credentials.

### Google (Gmail / Google Workspace) SMTP setup: the account owner does this

Nobody else can do these steps, and no Google password or App Password belongs in the code or in GitHub.

1. Pick the Google account that will send the mail (a dedicated address such as `no-reply@your-domain` on Google Workspace is best;
   a personal Gmail account works but has lower daily sending limits: see Google's current documentation).
2. Turn on **2-Step Verification** for that account (Google Account > Security > 2-Step Verification).
3. Create an **App Password** (Google Account > Security > 2-Step Verification > App passwords, or open
   `myaccount.google.com/apppasswords`). Name it `DIRECTOR.LTD` and copy the 16-character code. Google shows it in groups of four; it can be
   entered with or without the spaces. The account's ordinary password will be refused. If "App passwords" is missing, 2-Step
   Verification is off, the account uses only security keys / Advanced Protection, or a Workspace administrator has disabled it.
4. Give the values to whoever configures the server:

   ```
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587                 # STARTTLS.  Or: SMTP_PORT=465 and SMTP_SECURE=true
   SMTP_SECURE=false
   SMTP_USER=<that Google account's address>
   SMTP_PASS=<the 16-character App Password>
   MAIL_FROM="DIRECTOR.LTD <that same address>"
   APP_BASE_URL=https://<the production domain>
   ```

   Gmail replaces any other sender address with the authenticated account's own (unless it is a verified "Send mail as" alias), so keep
   `MAIL_FROM` equal to `SMTP_USER`. To move to another provider later, change only these variables: no code changes.

### Configuring it on Plesk (Saimon)

These steps describe Plesk's usual Node.js layout; they have not been verified on your server, so adjust to what you see.

1. Plesk > Websites & Domains > the site > **Node.js** > *Custom environment variables*: add the variables above (`SMTP_HOST`,
   `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `APP_BASE_URL`) beside the existing `DATABASE_URL` / `AUTH_SECRET`.
   Use the real HTTPS domain for `APP_BASE_URL`. Do not put them in git: `.env*` is gitignored and `.env.example` holds only empty
   placeholders.
2. Restart the Node.js app so it picks them up.
3. **Check the connection** from the app folder: `npm run mail:check`. It prints the settings (the password is never shown),
   connects, negotiates TLS and logs in, and sends **no** email. A shell opened over SSH does not automatically receive Plesk's
   custom variables: either export them for that session, or put the same lines in a `.env` file in the app folder on the server only
   (the command reads it; never commit it). Common failures: `EAUTH` = the login was refused (use an App Password, check
   `SMTP_USER`); `ECONNECTION` / `ETIMEDOUT` = wrong host/port/`SMTP_SECURE`, or the server blocks outbound connections on that port.
4. **Send one real test email:** `npm run mail:check -- someone@example.com`, and confirm the message arrives (check spam). Only
   receiving it proves delivery.
5. **Test the real flow once:** open `/login` > *Forgot password?*, enter a real account address, open the emailed link within 30
   minutes, set a new password, sign in with it, and confirm the old one is refused.

### Deployment order

Do this for each deployment, in order (nothing here is run automatically):

1. `git pull` in the app folder.
2. `npm ci` (a clean install from the committed lockfile; verified in an isolated copy with no extra flags). Until this dependency fix,
   `npm ci` stopped with an ERESOLVE error because `package.json` pinned `eslint-config-next@14` while the project uses ESLint 9 and
   Next 16; it now uses `eslint-config-next@^16`, which also makes `npm run lint` work.
3. `npx prisma migrate status`: lists migrations not yet applied to *this* database. Expect, on a database that predates this work:
   `20261023120000_site_content` and `20261024120000_site_media` (CMS), `20261025120000_customer_company_views` and
   `20261026120000_password_reset_tokens`. Check the list is what you intend.
4. **Decide before applying anything.** Step 3 only *reports*; `npm run db:migrate` (= `prisma migrate deploy`) *applies* every pending
   migration, and that includes the two **CMS** migrations (`site_content`, `site_media`). Do not assume the CMS is ready to release with
   the customer and password-recovery work: confirm with Nick first. The migration files only add tables and none changes or deletes
   existing data, but they cannot be undone by redeploying. Take a database backup first. If the CMS must not go live yet, stop and ask
   (the customer and recovery migrations cannot be applied on their own with `migrate deploy`).
5. `npm run db:generate` (regenerates Prisma Client; on Windows the app must be stopped first).
6. `npm run build`
7. Restart the Node.js app in Plesk.
8. Run the mail checks above.

Rollback: redeploy the previous commit and restart. The added tables are harmless to older code and can stay.

## Cookies and consent

The public site shows a cookie banner on the home page and the two policy pages ([/cookie-policy](src/app/cookie-policy/page.tsx), [/privacy-policy](src/app/privacy-policy/page.tsx)). Both policy pages are marked as **drafts for review**: they describe what the software does, were checked against the code, and have not been reviewed by a lawyer. Facts only the site owner can supply (the legal entity, contact details, lawful bases, retention periods for account and activity data, the email provider) are listed on the privacy page as "not yet provided", never invented.

### What the application actually uses (audited from the source and the content security policy)

| Technology | Kind | Purpose | Lifetime | Category | Consent needed |
|---|---|---|---|---|---|
| `director_session` | cookie, HttpOnly, SameSite=Lax, Secure on HTTPS | sign-in session | 7 days (`SESSION_MAX_AGE_SECONDS`) | strictly necessary | no |
| `dl_cal_oauth` | cookie, HttpOnly, path `/api/calendar` | protects connecting Google Calendar | 10 minutes, deleted when the flow ends | strictly necessary | no |
| `director_consent` | cookie, readable by the page | remembers the cookie choice (policy version, video choice, time) | 180 days | strictly necessary | no |
| `pendingReportFilter`, `pendingReportQuery`, `pendingReportColumns`, `pendingReportSort` | sessionStorage | carries a search to the Report Builder when a signed-in user clicks to create a report | until used / tab closed | strictly necessary for the requested feature | no |
| `cms-colour-memory-v1` | localStorage | recent colours in the website editor (Super Admin only, never set for visitors or customers) | until cleared | staff-only editor preference | flagged for legal review |
| YouTube (`youtube-nocookie.com`) and Vimeo (`player.vimeo.com`) players | third-party frames, only where an editor added a video section | embedded video | set by the provider | **optional ("media")** | **yes, and enforced** |

There are **no** analytics, advertising, tracking or social-widget technologies. The CSP (`script-src`/`img-src`/`font-src`/`connect-src` are `'self'`, `frame-src` allows only YouTube and Vimeo) would block them, fonts are self-hosted at build time, and an automated test fails if any such code or any third-party request appears. Do not add a consent category unless the application really uses it, and raise `CONSENT_VERSION` in [src/lib/consent.ts](src/lib/consent.ts) whenever the categories change so everyone is asked again.

### How it behaves

- **Banner:** shown only while there is *no valid saved choice* (none, malformed, another version, dated in the future, or older than 180 days). **Accept all** and **Reject non-essential** look and work the same; **Cookie settings** opens the preferences. Opening settings and closing them without saving changes nothing and the banner returns.
- **A valid choice is remembered** for 180 days and the banner does not reappear. This is the reason "it showed once and then never again" after you have chosen. The footer **Cookie settings** link reopens the settings at any time and shows the *current* saved choice.
- **Enforcement:** with videos not allowed, the server-rendered HTML and the first browser render contain only a placeholder; the browser makes no request to YouTube or Vimeo. Allowing loads the player; withdrawing removes it from the page immediately. A choice is only reported as saved after the browser confirms the cookie was stored; if cookies are blocked, the banner/settings stay open and say so.
- **Never touched by consent changes:** the sign-in session and every other cookie. Only `director_consent` is written or cleared.

### Testing a first-time visit locally

Use any one of these (none touches your session or other data):

1. **Development only:** open `http://localhost:3000/?reset-consent=1`. It deletes only the `director_consent` cookie and removes the parameter from the address bar. It does nothing in a production build.
2. Chrome DevTools > Application > Cookies > `http://localhost:3000` > delete the single `director_consent` row, then reload.
3. A private/incognito window.

## Reports: print and share

- **Print** prints the rows currently on screen (one page of results). Use **Export CSV** for the whole report. (The requirements document was not available in the repository; if full-report printing is required it is a separate change.)
- **Share** copies the report URL. The link is not public: it opens only for signed-in users who may see that report (its owner, and Admins/Super Admins). Teammates with the `USER` role cannot open someone else's report.

## Operations

```bash
npm run ch:bulk-ingest -- --input <zip|csv|url> [--limit N]   # monthly bulk file; --resume <runId> to continue an interrupted run
npm run ch:bulk-ingest -- --input <file> --dry-run [--snapshot-date YYYY-MM-DD]   # read-only: validates the whole file, predicts inserts/updates/unchanged/protected/rejected
npm run ch:bulk-ingest -- --retry-failed <runId>   # retry database-failed rows from the failed-row ledger (IngestRowFailure)
npm run ch:bulk-ingest -- --search --status active --limit 2000 --enrich 200   # small real sample via Advanced Search
npm run ch:stream                # always-on DS01 stream worker (reconnects, resumes from checkpoint)
npm run ch:new-registrations     # newly incorporated companies since the last covered day (Advanced Search, 1 request/day; idempotent)
npm run ch:daily-update          # overdue flags, pending DS01 events, queues officer work (no API calls), report refresh
npm run ch:officer-worker -- --status          # officer pipeline health (read-only, no API calls)
npm run ch:officer-worker -- --limit 500       # fetch officers for up to 500 queued companies, then stop
npm run ch:officer-worker -- --limit 500 --crawl   # ...and also walk the background crawl (opt-in)
npm run jobs:scheduler           # in-process scheduler (new registrations every 6h whenever COMPANIES_HOUSE_API_KEY is set; daily 03:00 UTC; monthly ingest only if MONTHLY_INGEST_ENABLED=1)
# Production (Plesk, Windows/Linux supervisors, env vars, monitoring): see docs/PRODUCTION_SCHEDULER.md
# npm run jobs:once (one pass, for scheduled-task fallback) / npm run jobs:status (heartbeat + job status)
# Phase 1 live updates: keep ONE process running -  STREAM_WORKER_ENABLED=1 npm run jobs:scheduler
#   (daily update at 03:00 UTC, retried every 30 min up to 5x/day on failure, never run twice per UTC day;
#    filing stream runs inside it - do not also run ch:stream). Proof it ran: an IngestionRun row of kind
#    daily_update (Settings/Super Admin; also shown on each report page). Report.lastRunAt is also set by manual Refresh.
```

## Officer coverage (director filters at scale)

`directorCount` / `singleDirector` are only meaningful for companies whose officers have been fetched, so officer data has an explicit **state** (`Company.officersCoverage`):

| state | meaning |
|---|---|
| `none` | officers never fetched (the count columns are placeholders) |
| `full` | every officer page fetched; the count is confirmed (a genuine empty list is `full` / 0) |
| `unavailable` | Companies House has no officer data (`officersUnavailableReason`: `no_officer_resource` or `company_gone`). **Never** a zero. |

Staleness is derived, not stored: `officersFetchedAt` older than `OFFICER_STALE_AFTER_DAYS`, or `officersDirtyAt` newer than `officersFetchedAt` (an officer filing was seen). Stale/dirty companies keep their last confirmed count but are labelled "Not recently verified" / "Update pending".

**Director filters** (`directorCount`, `singleDirector`) only evaluate `full` companies. Every search/report with a director rule also returns an *unknown* count: companies that pass all the other conditions but could not be evaluated (`none` / `unavailable`). The UI shows "N companies match. M additional companies could not be evaluated because officer data is not available yet" and a **Fetch officer data for these companies** button, which only *queues* work (capped by `OFFICER_ENQUEUE_CAP`). Implementation: the filter is compiled twice (`confirmed` and `possible`, see `src/lib/filters/compile.ts`); unknown = count(possible) - count(confirmed).

**CSV export**: `Director count` / `Single director` / `Officer data as of` carry real values only for `full` rows (stale/dirty rows are suffixed); otherwise `Not fetched` or `Unavailable`. Export never calls Companies House.

**Pipeline** (all officer fetching is in the dedicated worker, `npm run ch:officer-worker`):

- *Queue* (`OfficerSyncJob`): priorities P1 saved reports, P2 followed, P3 ad-hoc director filter, P4 stale/dirty refresh; P0 (a company being viewed) is fetched inline on the `user` quota class. Enqueue is idempotent (highest priority wins); claiming uses `FOR UPDATE SKIP LOCKED` with a lease; a dead worker's leases expire back into the queue without charging attempts.
- *Background crawl* (P5): a keyset cursor over `Company` (active companies first, partial indexes, never `OFFSET`, no per-company queue rows). **Opt-in**: `--crawl` (or `OFFICER_CRAWL_ENABLED=1` for the scheduler).
- *Retries*: per company, exponential backoff with jitter (5 m, 30 m, 2 h, 8 h, 24 h, 72 h), parked after `OFFICER_MAX_ATTEMPTS`; at most ~10% of a batch may be retries. Systemic failures (429, breaker, outage, bad key) never consume attempts. Parked companies are listed on the Super Admin page with a manual retry.
- *404*: officers 404 + profile 200 -> `unavailable/no_officer_resource`; both 404 -> `unavailable/company_gone`; a 404 for an already-confirmed company leaves its data untouched.
- *Shared quota gate* (`quota.ts`): one PostgreSQL row shared by every process; classes `user > filing > stream > refresh > backfill`; reservations are configurable policy (`CH_QUOTA_*`) and demand-aware (a class keeps its full reservation only while it has recent demand, otherwise just a small floor, so the background crawl can use idle capacity), background classes are paced evenly across the window, `X-Ratelimit-*` headers are authoritative, a real 429 opens a global cooldown, and the backfill is always the first to yield. Internal quota denials and real 429s are different events (`ChQuotaEvent`, Super Admin page). Throughput is **measured** (Super Admin page), not promised.
- *Circuit breakers* (`breaker.ts`, persisted): repeated 401/403 stops all REST traffic until a manual reset or a successful half-open probe; a 5xx/network failure wave pauses background work only.
- *Freshness*: officer filings on the filing stream (AP01/AP02/TM01, LLP equivalents, NEWINC) mark confirmed companies dirty and queue a P4 refresh; a TTL sweep and a soft refresh on detail-page views are the safety net.

Starting a controlled backfill later (nothing here is run automatically):

```
npm run ch:officer-worker -- --status                      # check health first (no API calls)
npm run ch:officer-worker -- --limit 500 --crawl           # pilot: 500 companies
npm run ch:officer-worker -- --limit 5000 --crawl          # larger pilot
npm run ch:officer-worker -- --crawl --max-minutes 60      # sustained, bounded run
```


- Loading the full register requires the explicit flag `--i-understand-this-is-the-full-register`; without `--limit` a full-size file is refused.
- The bulk loader reads the `.zip` Companies House publishes (streamed, never fully in memory), validates the header, parses `DD/MM/YYYY`, maps categories explicitly (unknown values are recorded and reported, never dropped), and requires a **UTF-8** database.
- Run outcome: `success` (no errors, or ≤0.1 % rows failed/skipped) · `partial` (≤5 %) · `failed` (>5 %, or nothing read). Row counters, error samples and unknown categories are stored on the run and shown in Settings / Super Admin.
- A run with no heartbeat for 10 minutes (2 minutes for the officer worker, which heartbeats every 30 s) is shown as `stalled` and reconciled to `failed`. Only one bulk/daily/officer job of a kind runs at a time (PostgreSQL advisory lock).
- **Stream delivery is at-least-once with idempotent processing**, not exactly-once: DS01/DS02 events are persisted before the checkpoint moves; after a drop/restart the stream is replayed from the checkpoint and the unique `transactionId` absorbs duplicates. If Companies House no longer holds the checkpoint (long downtime) the gap is logged and counted — those events cannot be recovered from the stream.
- Health: `GET /api/health` (public: ok/degraded/down; Super Admin session adds job detail). Logs are JSON lines in production (`LOG_FORMAT=json|text`).
- AWS shape: stream worker = always-on ECS/Fargate task; daily update/bulk = EventBridge scheduled task (or the built-in scheduler); PostgreSQL = RDS (UTF-8, `sslmode=require`). Not yet validated on AWS.

## Testing

```bash
npm run typecheck && npm run lint
npm test                              # unit tests (dates, mapping, filters, CSV safety, password policy, ZIP input, ...)
npm run build && npm run test:integration   # scratch PostgreSQL + production build: security, sessions, CRM, filters, ingestion, resume, stream (mock Companies House)
DATABASE_URL=<empty scratch db> npx tsx tests/acceptance/ingest-100k.ts tmp-ingest/sample-100k.zip   # 100k-row acceptance test
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit tests, build and the integration suite on every push.
