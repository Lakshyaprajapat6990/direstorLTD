import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appBaseUrl, isMailConfigured, mailConfig, mailSettingsProblems } from "../../src/lib/mail";
import { hashResetToken, looksLikeResetToken, RESET_TOKEN_TTL_MS } from "../../src/lib/auth/password-reset";

const root = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

function setEnv(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(env)) setEnv(k, v);
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) setEnv(k, v);
  }
}
const CLEAR = { SMTP_HOST: undefined, SMTP_PORT: undefined, SMTP_SECURE: undefined, SMTP_REQUIRE_TLS: undefined, SMTP_USER: undefined, SMTP_PASS: undefined, MAIL_FROM: undefined, APP_BASE_URL: undefined, NEXTAUTH_URL: undefined };

test("mail is unconfigured unless both a server and a sender are set, and half a credential is refused", () => {
  withEnv(CLEAR, () => assert.equal(isMailConfigured(), false));
  withEnv({ ...CLEAR, SMTP_HOST: "smtp.example.com" }, () => assert.equal(isMailConfigured(), false));
  withEnv({ ...CLEAR, MAIL_FROM: "a@example.com" }, () => assert.equal(isMailConfigured(), false));
  withEnv({ ...CLEAR, SMTP_HOST: "smtp.example.com", MAIL_FROM: "a@example.com", SMTP_USER: "u" }, () => assert.equal(isMailConfigured(), false, "user without password"));
  withEnv({ ...CLEAR, SMTP_HOST: "smtp.example.com", MAIL_FROM: "a@example.com", SMTP_PASS: "p" }, () => assert.equal(isMailConfigured(), false, "password without user"));
});

test("mail defaults are safe: STARTTLS on 587 with TLS required; implicit TLS on 465", () => {
  const base = { ...CLEAR, SMTP_HOST: "smtp.example.com", MAIL_FROM: "DIRECTOR.LTD <no-reply@example.com>" };
  withEnv(base, () => {
    const c = mailConfig()!;
    assert.equal(c.port, 587);
    assert.equal(c.secure, false);
    assert.equal(c.requireTLS, true);
    assert.equal(c.user, undefined);
  });
  withEnv({ ...base, SMTP_SECURE: "true" }, () => assert.equal(mailConfig()!.port, 465));
  withEnv({ ...base, SMTP_PORT: "2525", SMTP_USER: "u", SMTP_PASS: "p" }, () => {
    const c = mailConfig()!;
    assert.equal(c.port, 2525);
    assert.equal(c.user, "u");
  });
  withEnv({ ...base, SMTP_PORT: "99999" }, () => assert.equal(mailConfig()!.port, 587));
  withEnv({ ...base, SMTP_REQUIRE_TLS: "false" }, () => assert.equal(mailConfig()!.requireTLS, false));
});

test("the link base comes from configuration only and must be an http(s) origin", () => {
  withEnv(CLEAR, () => assert.equal(appBaseUrl(), null));
  withEnv({ ...CLEAR, APP_BASE_URL: "https://app.example.com/some/path?x=1" }, () => assert.equal(appBaseUrl(), "https://app.example.com"));
  withEnv({ ...CLEAR, NEXTAUTH_URL: "http://localhost:3000" }, () => assert.equal(appBaseUrl(), "http://localhost:3000"));
  withEnv({ ...CLEAR, APP_BASE_URL: "https://a.example.com", NEXTAUTH_URL: "https://b.example.com" }, () => assert.equal(appBaseUrl(), "https://a.example.com"));
  for (const bad of ["javascript:alert(1)", "ftp://x.example", "not a url", "//evil.example"]) withEnv({ ...CLEAR, APP_BASE_URL: bad }, () => assert.equal(appBaseUrl(), null, bad));
  const route = read("src/app/api/auth/forgot-password/route.ts");
  assert.ok(!/request\.headers\.get\(["'](host|x-forwarded-host|origin)/i.test(route), "the link must never be built from request headers");
});

test("reset tokens: format check, SHA-256 hashing, 30 minute lifetime", () => {
  const good = "A".repeat(43);
  assert.ok(looksLikeResetToken(good));
  for (const bad of ["", "A".repeat(42), "A".repeat(44), "A".repeat(42) + "=", "A".repeat(42) + " ", 5, null, undefined, {}]) assert.ok(!looksLikeResetToken(bad as unknown));
  assert.equal(hashResetToken("x"), "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  assert.equal(hashResetToken(good).length, 64);
  assert.equal(RESET_TOKEN_TTL_MS, 30 * 60 * 1000);
});

test("the recovery code never logs or returns a secret, and tokens use a CSPRNG", () => {
  for (const f of ["src/app/api/auth/forgot-password/route.ts", "src/app/api/auth/reset-password/route.ts"]) {
    const code = read(f);
    for (const call of code.match(/log\.(error|warn|info|debug)\([^;]*\);/g) ?? []) {
      assert.ok(!/(token|link|email|password|raw|issued)/i.test(call.replace(/"recovery\.[a-z_]+"/, "")), `${f}: log call must not include secrets: ${call}`);
    }
  }
  assert.ok(!/console\./.test(read("src/lib/mail/index.ts") + read("src/lib/auth/password-reset.ts")));
  const lib = read("src/lib/auth/password-reset.ts");
  assert.match(lib, /randomBytes\(32\)/);
  assert.ok(!/Math\.random/.test(lib));
  // The raw token is only ever inside the emailed link and the hash lookup.
  assert.ok(!/tokenHash:\s*raw\b/.test(lib));
});

test("the forgot-password response is sent before any account work happens", () => {
  const code = read("src/app/api/auth/forgot-password/route.ts");
  const after = code.indexOf("after(async");
  assert.ok(after > 0);
  assert.ok(code.indexOf("db.user.findUnique") > after, "the account lookup runs after the response");
  assert.ok(code.indexOf("issueResetToken(") > after && code.indexOf("sendMail(") > after);
});

const GMAIL = { ...CLEAR, SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_SECURE: "false", SMTP_USER: "sender@gmail.com", SMTP_PASS: "abcd efgh ijkl mnop", MAIL_FROM: "DIRECTOR.LTD <sender@gmail.com>", APP_BASE_URL: "https://app.example.com" };

test("mailSettingsProblems names what is wrong, by variable name only, and is empty for the Gmail settings in the README", () => {
  withEnv(GMAIL, () => assert.deepEqual(mailSettingsProblems(), []));
  withEnv({ ...GMAIL, SMTP_PORT: "465", SMTP_SECURE: "true" }, () => assert.deepEqual(mailSettingsProblems(), []));
  withEnv(CLEAR, () => {
    const p = mailSettingsProblems();
    assert.ok(p.some((x) => x.startsWith("SMTP_HOST")) && p.some((x) => x.startsWith("MAIL_FROM")) && p.some((x) => x.startsWith("APP_BASE_URL")));
  });
  withEnv({ ...GMAIL, SMTP_PORT: "465", SMTP_SECURE: "false" }, () => assert.ok(mailSettingsProblems().some((x) => x.includes("SMTP_SECURE=true"))));
  withEnv({ ...GMAIL, SMTP_PORT: "587", SMTP_SECURE: "true" }, () => assert.ok(mailSettingsProblems().some((x) => x.includes("STARTTLS"))));
  withEnv({ ...GMAIL, SMTP_PASS: undefined }, () => assert.ok(mailSettingsProblems().some((x) => x.includes("SMTP_USER and SMTP_PASS"))));
  withEnv({ ...GMAIL, SMTP_PORT: "abc" }, () => assert.ok(mailSettingsProblems().some((x) => x.includes("SMTP_PORT"))));
  withEnv({ ...GMAIL, MAIL_FROM: "no address here" }, () => assert.ok(mailSettingsProblems().some((x) => x.includes("MAIL_FROM must contain"))));
  withEnv({ ...GMAIL, APP_BASE_URL: "javascript:alert(1)" }, () => assert.ok(mailSettingsProblems().some((x) => x.startsWith("APP_BASE_URL"))));
  // A problem list never contains a value (so it is safe to print): no password, address or host.
  withEnv({ ...GMAIL, SMTP_PORT: "465", SMTP_SECURE: "false" }, () => {
    const all = mailSettingsProblems().join(" ");
    for (const secret of ["abcd efgh", "sender@gmail.com", "smtp.gmail.com"]) assert.ok(!all.includes(secret), secret);
  });
});

test("the Gmail settings parse as documented: STARTTLS on 587 and implicit TLS on 465, TLS required, credentials kept", () => {
  withEnv(GMAIL, () => {
    const c = mailConfig()!;
    assert.deepEqual([c.host, c.port, c.secure, c.requireTLS, c.user], ["smtp.gmail.com", 587, false, true, "sender@gmail.com"]);
  });
  withEnv({ ...GMAIL, SMTP_PORT: "465", SMTP_SECURE: "true" }, () => {
    const c = mailConfig()!;
    assert.deepEqual([c.port, c.secure], [465, true]);
  });
});

test("no credential is hardcoded: .env.example ships empty SMTP login values and the mail code holds no literal password", () => {
  const lines = read(".env.example").split(/\r?\n/);
  const value = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).replace(/^"|"$/g, "");
  assert.equal(value("SMTP_USER"), "");
  assert.equal(value("SMTP_PASS"), "");
  assert.ok(!/@gmail\.com/i.test(value("MAIL_FROM") ?? ""), ".env.example must not name a real Gmail account");
  for (const f of ["src/lib/mail/index.ts", "scripts/mail-check.ts", "src/app/api/auth/forgot-password/route.ts"]) {
    assert.ok(!/(pass(word)?|pwd)\s*[:=]\s*["'][^"'$]{6,}["']/i.test(read(f).replace(/process\.env\.SMTP_PASS/g, "")), `${f}: no literal password`);
  }
});

test("a logged warning uses console.warn (never console.error, which Next's dev server shows as a red error overlay)", async () => {
  const { makeLogger } = await import("../../src/lib/log");
  const calls: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  console.error = () => calls.push("error");
  console.warn = () => calls.push("warn");
  console.log = () => calls.push("log");
  try {
    withEnv({ LOG_FORMAT: "text" }, () => {
      const l = makeLogger("t");
      l.warn("w", { problems: ["SMTP_HOST is not set."] });
      l.error("e");
      l.info("i");
    });
  } finally {
    Object.assign(console, saved);
  }
  assert.deepEqual(calls, ["warn", "error", "log"]);
});

test("the forgot-password page logs a missing-configuration warning at most once per process and prints setting names only", () => {
  const page = read("src/app/forgot-password/page.tsx");
  assert.match(page, /let warned = false/);
  assert.match(page, /if \(!available\) warnNotConfiguredOnce\(\)/);
  assert.ok(/log\.warn\("recovery\.not_configured", \{ problems: mailSettingsProblems\(\) \}\)/.test(page));
});
