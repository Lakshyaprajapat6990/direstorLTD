// Integration test runner (isolated scratch PostgreSQL + production build of the app).
//   npm run build && npm run test:integration
// - starts a throwaway PostgreSQL cluster in ./.pgdata-test on port 5434 (no Docker)
// - applies the real migrations, then runs tests/integration/*.test.ts
// - starts three app servers from the production build:
//     :3211  seed data visible, export cap for USER = 50 rows
//     :3212  seed data hidden (production-like)
//     :3213  Google Calendar configured with FAKE credentials (the first two have it unconfigured)
// Never touches the development database.
import EmbeddedPostgres from "embedded-postgres";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(".pgdata-test");
const port = 5434;
const dbUrl = `postgresql://director:director_test_local@127.0.0.1:${port}/director_test?schema=public`;
const isWin = process.platform === "win32";

async function waitForHttp(url: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not start: ${url}`);
}

function startServer(p: number, extraEnv: Record<string, string>): ChildProcess {
  const child = spawn(isWin ? "npx.cmd" : "npx", ["next", "start", "-p", String(p)], {
    env: { ...process.env, ...extraEnv, DATABASE_URL: dbUrl, PORT: String(p), AVATAR_DIR: path.join(dir, "avatars") },
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin,
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", (d) => process.stderr.write(`[server ${p}] ${d}`));
  return child;
}

async function main() {
  if (!fs.existsSync(".next/BUILD_ID")) throw new Error("Run `npm run build` first (the integration suite tests the production build).");
  fs.rmSync(dir, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "director", password: "director_test_local", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("director_test");

  const servers: ChildProcess[] = [];
  let exitCode = 1;
  try {
    const mig = spawnSync(isWin ? "npx.cmd" : "npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "inherit", shell: isWin });
    if (mig.status !== 0) throw new Error("migrate deploy failed");

    const authSecret = randomBytes(48).toString("base64url");
    const common = { AUTH_SECRET: authSecret, TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("hex"), TRUST_PROXY: "1", RESEND_API_KEY: "", EMAIL_FROM: "", APP_URL: "", RESEND_API_URL: "" }; // blank on purpose: next start would otherwise read a developer's real .env.local
    // Google Calendar: the first two servers are deliberately NOT configured (whatever the developer's .env says), the third
    // is configured with fake credentials so the connect / callback flow can be tested without talking to Google.
    const noGoogle = { GOOGLE_CALENDAR_CLIENT_ID: "", GOOGLE_CALENDAR_CLIENT_SECRET: "", GOOGLE_CALENDAR_REDIRECT_URI: "" };
    const fakeGoogle = {
      GOOGLE_CALENDAR_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_CALENDAR_CLIENT_SECRET: "test-client-secret",
      GOOGLE_CALENDAR_REDIRECT_URI: "http://127.0.0.1:3213/api/calendar/callback/google",
    };
    // Password recovery: :3211 sends mail to the SMTP sink that tests/integration/password-recovery.test.ts runs on 127.0.0.1:2526
    // (a real SMTP conversation, but to a local test listener, not a mailbox). :3212 has no mail configured at all.
    const smtp = { SMTP_HOST: "127.0.0.1", SMTP_PORT: "2526", SMTP_SECURE: "false", SMTP_REQUIRE_TLS: "false", SMTP_USER: "", SMTP_PASS: "", MAIL_FROM: "DIRECTOR.LTD <no-reply@test.example>", APP_BASE_URL: "http://127.0.0.1:3211" };
    const noSmtp = { SMTP_HOST: "", MAIL_FROM: "", APP_BASE_URL: "" };
    servers.push(startServer(3211, { ...common, ...noGoogle, ...smtp, SEED_DATA_VISIBLE: "true", EXPORT_MAX_ROWS_USER: "50", EXPORT_MAX_ROWS_ADMIN: "500" }));
    servers.push(startServer(3212, { ...common, ...noGoogle, ...noSmtp, SEED_DATA_VISIBLE: "false" }));
    servers.push(startServer(3213, { ...common, ...fakeGoogle, SEED_DATA_VISIBLE: "true" }));
    // :3214 sends through the Resend integration, pointed at the mock Resend API that tests/integration/password-recovery-resend.test.ts runs on 127.0.0.1:2527.
    const resend = { RESEND_API_KEY: "re_test_key_not_real", EMAIL_FROM: "DIRECTOR.LTD <onboarding@resend.dev>", APP_URL: "http://127.0.0.1:3214", RESEND_API_URL: "http://127.0.0.1:2527" };
    servers.push(startServer(3214, { ...common, ...noGoogle, ...noSmtp, ...resend, SEED_DATA_VISIBLE: "false" }));
    await Promise.all([waitForHttp("http://127.0.0.1:3211/login"), waitForHttp("http://127.0.0.1:3212/login"), waitForHttp("http://127.0.0.1:3213/login"), waitForHttp("http://127.0.0.1:3214/login")]);

    const files = fs.readdirSync("tests/integration").filter((f) => f.endsWith(".test.ts")).map((f) => path.join("tests/integration", f));
    const only = process.argv[2];
    // Asynchronous on purpose: waiting synchronously would freeze this process's event loop for the whole run, and with it the
    // reading of the throw-away PostgreSQL's and the app servers' output pipes. Once enough had been logged (the suites provoke
    // many deliberate database errors) a pipe filled, the database blocked writing its log, and the whole run hung.
    exitCode = await new Promise<number>((resolve) => {
      const child = spawn(isWin ? "npx.cmd" : "npx", ["tsx", "--test", "--test-concurrency=1", ...(only ? files.filter((f) => f.includes(only)) : files)], {
        env: { ...process.env, DATABASE_URL: dbUrl, TEST_BASE_URL: "http://127.0.0.1:3211", TEST_BASE_URL_PROD: "http://127.0.0.1:3212", TEST_BASE_URL_GOOGLE: "http://127.0.0.1:3213", TEST_BASE_URL_RESEND: "http://127.0.0.1:3214", ...common },
        stdio: "inherit",
        shell: isWin,
      });
      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
  } finally {
    for (const s of servers) {
      if (isWin && s.pid) spawnSync("taskkill", ["/pid", String(s.pid), "/T", "/F"], { stdio: "ignore" });
      else s.kill();
    }
    await pg.stop().catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
