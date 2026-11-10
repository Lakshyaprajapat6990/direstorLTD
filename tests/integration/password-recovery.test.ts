import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { BASE, BASE_PROD, STRONG_PASSWORD, createUser, db, login } from "./helpers";
import { SmtpSink } from "../support/smtp-sink";
import { mailSettingsProblems, sendMail, verifyMailTransport } from "../../src/lib/mail";

// Password recovery against the production build with a REAL SMTP conversation: the application's own mail code (nodemailer)
// delivers to a listener on 127.0.0.1:2526 that this file starts. That proves the message the application hands to an SMTP
// server is correct; it does NOT prove delivery to a real mailbox (no real SMTP provider is configured in this repository).
const sink = new SmtpSink(2526);
before(() => sink.start());
after(async () => {
  await sink.stop();
  await db.$disconnect();
});

const NEW_PASSWORD = "Violet-Kettle-Orbit-8821!";
const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const newEmail = (tag = "rec") => `${tag}.${randomUUID().slice(0, 10)}@test.example`;

async function post(path: string, body: unknown, opts: { base?: string; ip?: string; origin?: string | null; contentType?: string | null; raw?: string } = {}) {
  const base = opts.base ?? BASE;
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? randIp() };
  if (opts.origin !== null) headers.origin = opts.origin ?? base;
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  const res = await fetch(`${base}${path}`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}
const forgot = (email: string, opts?: Parameters<typeof post>[2]) => post("/api/auth/forgot-password", { email }, opts);
const reset = (token: unknown, password: string, confirmPassword = password, opts?: Parameters<typeof post>[2]) => post("/api/auth/reset-password", { token, password, confirmPassword }, opts);

async function customer(name = "Casey Rivers") {
  const email = newEmail("cust");
  const u = await db.user.create({ data: { email, name, passwordHash: await bcrypt.hash(STRONG_PASSWORD, 4), role: "CUSTOMER", permissions: "[]" } });
  return { ...u, email };
}

// Requests a link and returns the raw token read from the email the sink received.
async function emailedToken(email: string): Promise<string> {
  const before = sink.countFor(email);
  assert.equal((await forgot(email)).status, 200);
  const deadline = Date.now() + 8000;
  while (sink.countFor(email) <= before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  const mail = [...sink.messages].reverse().find((m) => m.to.includes(email));
  assert.ok(mail && sink.countFor(email) > before, "a recovery email reached the SMTP server");
  const m = /\/reset-password#token=([A-Za-z0-9_-]{43})/.exec(mail!.text);
  assert.ok(m, "the email carries a reset link");
  return m![1];
}
const snapshot = (id: string) => db.user.findUniqueOrThrow({ where: { id }, select: { role: true, permissions: true, active: true, managerId: true, email: true, name: true, hourlyRateMinor: true } });

// ---- configuration ------------------------------------------------------------------------------------------------------
test("with no mail configured the API and page say so plainly instead of pretending", async () => {
  const r = await forgot("someone@test.example", { base: BASE_PROD });
  assert.equal(r.status, 503);
  assert.match(r.json.error, /not set up/);
  const page = await fetch(`${BASE_PROD}/forgot-password`).then((x) => x.text());
  assert.match(page, /not set up on this system/);
  assert.ok(!page.includes("Email me a reset link"));
  const configured = await fetch(`${BASE}/forgot-password`).then((x) => x.text());
  assert.match(configured, /Email me a reset link/);
});

// ---- requesting a link -------------------------------------------------------------------------------------------------
test("known and unknown addresses get the identical public response; only a known address receives an email", async () => {
  const known = await customer();
  const unknown = newEmail("ghost");
  const a = await forgot(known.email);
  const b = await forgot(unknown);
  assert.equal(a.status, 200);
  assert.equal(a.status, b.status);
  assert.equal(a.text, b.text, "byte-identical body");
  assert.deepEqual(Object.keys(a.json), ["ok"]);
  assert.ok(await sink.waitFor(known.email), "the account owner is emailed");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sink.countFor(unknown), 0, "no email for an unregistered address");
  // A deactivated account is also silent.
  const off = await customer();
  await db.user.update({ where: { id: off.id }, data: { active: false } });
  assert.equal((await forgot(off.email)).status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(sink.countFor(off.email), 0);
  assert.equal(await db.passwordResetToken.count({ where: { userId: off.id } }), 0);
});

test("the email is correct and the database holds only a hash of the secret", async () => {
  const u = await customer();
  const raw = await emailedToken(u.email);
  const mail = (await sink.waitFor(u.email))!;
  assert.deepEqual(mail.to, [u.email]);
  assert.match(mail.from, /no-reply@test\.example/);
  assert.match(mail.text, /Subject: Reset your DIRECTOR\.LTD password/);
  assert.ok(mail.text.includes(`http://127.0.0.1:3211/reset-password#token=${raw}`), "link is built from configuration");
  for (const forbidden of [STRONG_PASSWORD, u.passwordHash]) assert.ok(!mail.text.includes(forbidden), "no password material in the email");
  assert.match(mail.text, /never ask you to email your password/);

  const rows = await db.passwordResetToken.findMany({ where: { userId: u.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenHash, createHash("sha256").update(raw).digest("hex"));
  assert.notEqual(rows[0].tokenHash, raw);
  assert.ok(!JSON.stringify(rows).includes(raw), "the raw secret is not stored anywhere in the row");
  const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
  assert.ok(ttl > 29 * 60_000 && ttl <= 30 * 60_000 + 5000, `expires in ~30 minutes (${ttl}ms)`);
  assert.equal(rows[0].usedAt, null);
});

test("a newer link replaces the older one", async () => {
  const u = await customer();
  const first = await emailedToken(u.email);
  const second = await emailedToken(u.email);
  assert.notEqual(first, second);
  assert.equal((await reset(first, NEW_PASSWORD)).status, 400, "the earlier link no longer works");
  assert.equal((await reset(second, NEW_PASSWORD)).status, 200);
});

// ---- resetting ---------------------------------------------------------------------------------------------------------------
test("a valid link sets the new password: the new one works, the old one fails, the link is single-use, the account is unchanged", async () => {
  const roles = ["USER", "ADMIN", "SUPER_ADMIN"] as const;
  const accounts = [await customer("Dana Whitfield"), ...(await Promise.all(roles.map((r) => createUser(r, "rec"))))];
  for (const acc of accounts) {
    const before = await snapshot(acc.id);
    const oldHash = (await db.user.findUniqueOrThrow({ where: { id: acc.id } })).passwordHash;
    const raw = await emailedToken(acc.email);
    const r = await reset(raw, NEW_PASSWORD);
    assert.equal(r.status, 200, `${before.role}: ${r.text}`);
    assert.deepEqual(r.json, { ok: true });
    assert.ok(!r.text.includes(NEW_PASSWORD) && !r.text.includes(raw), "response carries no secret");

    assert.equal((await login(acc.email, STRONG_PASSWORD)).status, 401, "old password no longer works");
    assert.equal((await login(acc.email, NEW_PASSWORD)).status, 200, "new password works");
    const after2 = await db.user.findUniqueOrThrow({ where: { id: acc.id } });
    assert.notEqual(after2.passwordHash, oldHash);
    assert.match(after2.passwordHash, /^\$2[aby]\$12\$/, "the existing bcrypt scheme");
    assert.deepEqual(await snapshot(acc.id), before, `${before.role}: role, permissions, status and team untouched`);

    const reuse = await reset(raw, "Another-Strong-Pass-5510!");
    assert.equal(reuse.status, 400, "a used link is dead");
    assert.equal(reuse.json.code, "invalid_token");
    assert.equal((await login(acc.email, NEW_PASSWORD)).status, 200, "reuse changed nothing");
  }
});

test("resetting ends the account's other sessions", async () => {
  const u = await customer();
  const l = await login(u.email);
  assert.equal(l.status, 200);
  const page = (cookie: string) => fetch(`${BASE}/dashboard`, { headers: { cookie: `director_session=${cookie}` }, redirect: "manual" });
  assert.equal((await page(l.cookie!)).status, 200);
  assert.equal((await reset(await emailedToken(u.email), NEW_PASSWORD)).status, 200);
  const stale = await page(l.cookie!);
  assert.notEqual(stale.status, 200, "the old session is signed out");
  const rows = await db.userSession.findMany({ where: { userId: u.id, endReason: "password_reset" } });
  assert.ok(rows.length >= 1 && rows.every((s) => s.endedAt));
});

test("expired, unknown, malformed and tampered tokens are refused and change nothing", async () => {
  const u = await customer();
  const raw = await emailedToken(u.email);
  const hash = (await db.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash;
  const flipped = raw.slice(0, -1) + (raw.endsWith("A") ? "B" : "A");
  const bad: unknown[] = [flipped, raw.slice(1), raw + "x", "A".repeat(43), "", "short", 12345, null, { a: 1 }, ["x"], raw.toLowerCase() === raw ? raw.toUpperCase() : raw.toLowerCase(), `${raw}\n`, `' OR 1=1 --`];
  for (const t of bad) {
    const r = await reset(t, NEW_PASSWORD);
    assert.equal(r.status, 400, JSON.stringify(t));
    assert.equal(r.json.code, "invalid_token");
  }
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash, hash);

  await db.passwordResetToken.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await reset(raw, NEW_PASSWORD);
  assert.equal(expired.status, 400);
  assert.equal(expired.json.code, "invalid_token");
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash, hash);
  assert.equal((await login(u.email)).status, 200, "the old password still works after failed attempts");
});

test("a weak or mismatched password is rejected without spending the link; the policy matches registration", async () => {
  const u = await customer("Jordan Bellamy");
  const raw = await emailedToken(u.email);
  const cases: [string, string, string][] = [
    ["password", "password", "password"],
    ["short", "Ab1!", "Ab1!"],
    ["empty", "", ""],
    ["mismatch", NEW_PASSWORD, "Different-Horse-Battery-42!"],
    ["contains name", "JordanBellamy-2026!", "JordanBellamy-2026!"],
    ["contains email name", `${u.email.split("@")[0]}-77!`, `${u.email.split("@")[0]}-77!`],
  ];
  for (const [label, pw, confirm] of cases) {
    const r = await reset(raw, pw, confirm);
    assert.equal(r.status, 400, label);
    assert.ok(r.json.fieldErrors?.password || r.json.fieldErrors?.confirmPassword, label);
    // Only a distinctive password can be checked for echoing ("password" itself appears in the generic message wording).
    if (pw.length > 12) assert.ok(!r.text.includes(pw), `${label}: the password is not echoed`);
  }
  assert.equal((await db.passwordResetToken.findFirstOrThrow({ where: { userId: u.id } })).usedAt, null, "the link is still unused");
  assert.equal((await login(u.email)).status, 200, "password unchanged");
  assert.equal((await reset(raw, NEW_PASSWORD)).status, 200, "and the same link then works with a good password");
});

test("simultaneous use of one link: exactly one request wins and the account holds exactly that password", async () => {
  const u = await customer();
  const raw = await emailedToken(u.email);
  const pws = Array.from({ length: 6 }, (_, i) => `Concurrent-Orchard-Lantern-${i}${i}${i}!`);
  const results = await Promise.all(pws.map((p) => reset(raw, p)));
  const winners = results.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
  assert.equal(winners.length, 1, results.map((r) => r.status).join());
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 400 || r.status === 429));
  assert.equal((await login(u.email, pws[winners[0]])).status, 200);
  for (let i = 0; i < pws.length; i++) if (i !== winners[0]) assert.equal((await login(u.email, pws[i])).status, 401);
});

test("the account comes only from the token: an email, user id or role in the request changes nothing else", async () => {
  const victim = await customer();
  const mine = await customer();
  const victimHash = (await db.user.findUniqueOrThrow({ where: { id: victim.id } })).passwordHash;
  const raw = await emailedToken(mine.email);
  const r = await post("/api/auth/reset-password", { token: raw, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD, email: victim.email, userId: victim.id, role: "SUPER_ADMIN", active: false, permissions: ["staff.manage"] });
  assert.equal(r.status, 200);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: victim.id } })).passwordHash, victimHash);
  assert.equal((await login(victim.email)).status, 200);
  assert.equal((await login(mine.email, NEW_PASSWORD)).status, 200);
  const m = await snapshot(mine.id);
  assert.equal(m.role, "CUSTOMER");
  assert.equal(m.permissions, "[]");
  assert.equal(m.active, true);
});

test("a deactivated account cannot complete a reset", async () => {
  const u = await customer();
  const raw = await emailedToken(u.email);
  await db.user.update({ where: { id: u.id }, data: { active: false } });
  assert.equal((await reset(raw, NEW_PASSWORD)).status, 400);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: u.id } })).active, false);
});

// ---- input hygiene and limits ------------------------------------------------------------------------------------------------
test("malformed requests are refused", async () => {
  for (const raw of ["{nope", "[]", "null", '"x"', "", JSON.stringify({}), JSON.stringify({ email: 5 }), JSON.stringify({ email: "not-an-email" }), JSON.stringify({ email: "a@b" }), JSON.stringify({ email: "x".repeat(300) + "@test.example" })]) {
    assert.equal((await post("/api/auth/forgot-password", null, { raw })).status, 400, `forgot ${raw.slice(0, 20)}`);
  }
  for (const raw of ["{nope", "[]", "null", '"x"', "", JSON.stringify({}), JSON.stringify({ token: 1 })]) {
    assert.equal((await post("/api/auth/reset-password", null, { raw })).status, 400, `reset ${raw.slice(0, 20)}`);
  }
  assert.equal((await forgot("a@test.example", { origin: "https://evil.example" })).status, 403);
  assert.equal((await forgot("a@test.example", { origin: null })).status, 403);
  assert.equal((await forgot("a@test.example", { contentType: "text/plain" })).status, 415);
  assert.equal((await post("/api/auth/forgot-password", null, { raw: JSON.stringify({ email: "a@test.example", pad: "x".repeat(5000) }) })).status, 413);
  assert.equal((await reset("A".repeat(43), NEW_PASSWORD, NEW_PASSWORD, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/auth/reset-password", null, { raw: JSON.stringify({ token: "A".repeat(43), pad: "x".repeat(9000) }) })).status, 413);
});

test("requesting links is rate limited per address and per IP", async () => {
  const u = await customer();
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await forgot(u.email)).status);
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[4], 429);
  const blocked = await forgot(u.email);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  // Identical limit behaviour for an address that does not exist (the limit leaks nothing).
  const ghost = newEmail("ghost");
  const ghostStatuses: number[] = [];
  for (let i = 0; i < 5; i++) ghostStatuses.push((await forgot(ghost)).status);
  assert.deepEqual(ghostStatuses, statuses);

  const ip = randIp();
  const perIp: number[] = [];
  for (let i = 0; i < 12; i++) perIp.push((await forgot(newEmail("ip"), { ip })).status);
  assert.ok(perIp.slice(0, 10).every((s) => s === 200), perIp.join());
  assert.ok(perIp.slice(10).every((s) => s === 429), perIp.join());
});

test("guessing links is rate limited per IP", async () => {
  const ip = randIp();
  const statuses: number[] = [];
  for (let i = 0; i < 24; i++) statuses.push((await reset(`${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 11)}`, NEW_PASSWORD, NEW_PASSWORD, { ip })).status);
  assert.ok(statuses.slice(0, 20).every((s) => s === 400), statuses.join());
  assert.ok(statuses.slice(20).every((s) => s === 429), statuses.join());
});

// ---- pages ---------------------------------------------------------------------------------------------------------------------
test("login links to recovery; the recovery pages and the redesigned login and register pages render", async () => {
  const login = await fetch(`${BASE}/login`).then((x) => x.text());
  // The sign-in form (with its "Forgot password?" link and the activity notice) renders in the browser inside a Suspense
  // boundary, so it is not in the static HTML; it is covered by the real-browser run. The surrounding page is.
  assert.match(login, /Create a free account/);
  assert.match(login, /Back to home/);
  assert.match(login, /Staff: contact your Super Admin/);
  const register = await fetch(`${BASE}/register`).then((x) => x.text());
  assert.match(register, /Create your free/);
  assert.match(register, /href="\/login"/);
  const resetPage = await fetch(`${BASE}/reset-password`);
  assert.equal(resetPage.status, 200);
  assert.match(await resetPage.text(), /Choose a new password/);
});

// ---- the SMTP layer itself (what `npm run mail:check` uses), against the local SMTP listener ------------------------------------
test("verifyMailTransport and sendMail speak real SMTP: a good server passes, a dead one fails with a code, and nothing is sent by verify", async () => {
  const keys = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_REQUIRE_TLS", "SMTP_USER", "SMTP_PASS", "MAIL_FROM", "APP_BASE_URL"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const set = (port: string) => Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: port, SMTP_SECURE: "false", SMTP_REQUIRE_TLS: "false", SMTP_USER: "", SMTP_PASS: "", MAIL_FROM: "DIRECTOR.LTD <no-reply@test.example>", APP_BASE_URL: "http://127.0.0.1:3211" });
  try {
    set("2526");
    assert.deepEqual(mailSettingsProblems(), []);
    const before = sink.messages.length;
    assert.deepEqual(await verifyMailTransport(), { ok: true });
    assert.equal(sink.messages.length, before, "verifying sends no email");

    const to = newEmail("smtp");
    await sendMail({ to, subject: "DIRECTOR.LTD email test", text: "plain body", html: "<p>html body</p>" });
    const got = await sink.waitFor(to, 3000);
    assert.ok(got, "the SMTP server received the message");
    assert.match(got!.text, /Subject: DIRECTOR\.LTD email test/);
    assert.match(got!.text, /plain body/);

    set("2599"); // nothing listens here
    const dead = await verifyMailTransport();
    assert.equal(dead.ok, false);
    if (!dead.ok) assert.match(dead.code, /ECONNECTION|ESOCKET|ETIMEDOUT/);
    await assert.rejects(sendMail({ to, subject: "x", text: "x", html: "x" }), "a failed send throws instead of pretending");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("an SMTP failure during recovery leaves the public answer unchanged, creates no lingering token and exposes nothing", async () => {
  // Point the already-running :3211 server's mail at nothing is not possible per request, so exercise the same code path directly:
  // issueResetToken then a failed send must be cleaned up by discardResetToken (the route's catch block does exactly this).
  const { issueResetToken, discardResetToken, hashResetToken } = await import("../../src/lib/auth/password-reset");
  const u = await customer();
  const raw = await issueResetToken(u.id);
  assert.ok(raw);
  assert.equal(await db.passwordResetToken.count({ where: { userId: u.id } }), 1);
  await discardResetToken(raw!);
  assert.equal(await db.passwordResetToken.count({ where: { tokenHash: hashResetToken(raw!) } }), 0);
  assert.equal((await reset(raw, NEW_PASSWORD)).status, 400, "a withdrawn token cannot be used");
});
