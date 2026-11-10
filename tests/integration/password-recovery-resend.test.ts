import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { BASE_PROD, STRONG_PASSWORD, db, login } from "./helpers";
import { ResendMock } from "../support/resend-mock";
import { appBaseUrl, mailProvider, mailSettingsProblems, sendMail, verifyMailTransport } from "../../src/lib/mail";

// Password recovery through the Resend integration. The application server on :3214 talks to a MOCK of the Resend REST API that
// this file runs on 127.0.0.1:2527, so this proves what the application sends to Resend (key, sender, recipient, link) and how it
// copes with Resend refusing. It does NOT prove a real inbox received anything: the real-delivery check is manual (npm run mail:check).
const RESEND = process.env.TEST_BASE_URL_RESEND ?? "http://127.0.0.1:3214";
const mock = new ResendMock(2527);
before(() => mock.start());
after(async () => {
  await mock.stop();
  await db.$disconnect();
});

const NEW_PASSWORD = "Violet-Kettle-Orbit-8821!";
const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const newEmail = (tag = "rs") => `${tag}.${randomUUID().slice(0, 10)}@test.example`;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

async function post(path: string, body: unknown) {
  const res = await fetch(`${RESEND}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: RESEND, "x-forwarded-for": randIp() }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text || "null") as { ok?: boolean; error?: string } | null };
}
async function customer() {
  const email = newEmail("cust");
  const u = await db.user.create({ data: { email, name: "Casey Rivers", passwordHash: await bcrypt.hash(STRONG_PASSWORD, 4), role: "CUSTOMER", permissions: "[]" } });
  return { ...u, email };
}

test("with Resend configured the Forgot Password page shows the form, without any provider it shows the not-set-up notice", async () => {
  const on = await (await fetch(`${RESEND}/forgot-password`)).text();
  assert.match(on, /type="email"/);
  assert.doesNotMatch(on, /not set up on this system/);
  const off = await (await fetch(`${BASE_PROD}/forgot-password`)).text();
  assert.match(off, /Password recovery by email is not set up on this system yet/);
});

test("a registered address gets one email through Resend with the right key, sender and a working one-time link; only the hash is stored", async () => {
  const u = await customer();
  const r = await post("/api/auth/forgot-password", { email: u.email });
  assert.equal(r.status, 200);
  const msg = await mock.waitFor(u.email);
  assert.ok(msg, "Resend was asked to send the message");
  assert.equal(mock.authHeaders.at(-1), `Bearer ${mock.key}`);
  assert.equal(msg!.from, "DIRECTOR.LTD <onboarding@resend.dev>");
  assert.deepEqual(msg!.to, [u.email]);
  assert.equal(msg!.subject, "Reset your DIRECTOR.LTD password");
  const token = /http:\/\/127\.0\.0\.1:3214\/reset-password#token=([A-Za-z0-9_-]{43})/.exec(msg!.text)?.[1];
  assert.ok(token, "the link uses the configured APP_URL and carries a 256-bit token");
  assert.ok(msg!.html.includes(`#token=${token}`));
  const rows = await db.passwordResetToken.findMany({ where: { userId: u.id } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenHash, sha(token!));
  assert.ok(!JSON.stringify(rows).includes(token!), "the raw token is not stored");

  const done = await post("/api/auth/reset-password", { token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
  assert.equal(done.status, 200);
  assert.equal((await login(u.email, STRONG_PASSWORD, RESEND)).status, 401, "the old password is rejected");
  assert.equal((await login(u.email, NEW_PASSWORD, RESEND)).status, 200, "the new password signs in");
  assert.equal((await post("/api/auth/reset-password", { token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })).status, 400, "the token works once");
});

test("an unknown address gets the identical answer and no email", async () => {
  const known = await customer();
  const a = await post("/api/auth/forgot-password", { email: known.email });
  const ghost = newEmail("ghost");
  const b = await post("/api/auth/forgot-password", { email: ghost });
  assert.equal(b.status, a.status);
  assert.equal(b.text, a.text);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(mock.countFor(ghost), 0);
});

test("when Resend refuses, the public answer is unchanged, no token lingers and nothing sensitive leaks into the response", async () => {
  const u = await customer();
  mock.mode = "fail";
  try {
    const r = await post("/api/auth/forgot-password", { email: u.email });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    await new Promise((res) => setTimeout(res, 1200));
    assert.equal(await db.passwordResetToken.count({ where: { userId: u.id } }), 0, "a token that could not be mailed is withdrawn");
    assert.ok(!r.text.includes(mock.key) && !/resend|testing emails/i.test(r.text));
  } finally {
    mock.mode = "ok";
  }
});

test("the Resend client: key check, restricted key, wrong key, refusal carries Resend's error name but never the key", async () => {
  const keys = ["RESEND_API_KEY", "RESEND_API_URL", "EMAIL_FROM", "MAIL_FROM", "APP_URL", "APP_BASE_URL", "SMTP_HOST"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { RESEND_API_KEY: mock.key, RESEND_API_URL: "http://127.0.0.1:2527", EMAIL_FROM: "DIRECTOR.LTD <onboarding@resend.dev>", APP_URL: "http://localhost:3000", MAIL_FROM: "", APP_BASE_URL: "", SMTP_HOST: "" });
  try {
    assert.equal(mailProvider(), "resend");
    assert.deepEqual(mailSettingsProblems(), []);
    assert.equal(appBaseUrl(), "http://localhost:3000");
    assert.deepEqual(await verifyMailTransport(), { ok: true });
    mock.mode = "restricted";
    assert.deepEqual(await verifyMailTransport(), { ok: true }, "a send-only key is valid");
    mock.mode = "ok";

    const to = newEmail("client");
    await sendMail({ to, subject: "s", text: "t", html: "<p>h</p>" });
    assert.ok(await mock.waitFor(to, 2000));

    mock.mode = "fail";
    const err = await sendMail({ to, subject: "s", text: "t", html: "h" }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    assert.ok(err, "a refused send throws instead of pretending");
    assert.equal(err!.code, "validation_error");
    assert.ok(!err!.message.includes(mock.key));
    mock.mode = "ok";

    process.env.RESEND_API_KEY = "re_wrong_key";
    const bad = await verifyMailTransport();
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "invalid_api_key");
    await assert.rejects(sendMail({ to, subject: "s", text: "t", html: "h" }));

    process.env.RESEND_API_KEY = "";
    assert.equal(mailProvider(), null, "no key and no SMTP host means not configured");
    process.env.RESEND_API_KEY = mock.key;
    process.env.EMAIL_FROM = "";
    assert.equal(mailProvider(), null, "a key without a sender is not usable");
    assert.ok(mailSettingsProblems().some((p) => /EMAIL_FROM/.test(p)));
  } finally {
    mock.mode = "ok";
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
