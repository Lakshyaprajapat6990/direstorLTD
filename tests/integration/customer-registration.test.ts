import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, STRONG_PASSWORD, api, captchaFields, createUser, db, login, sessionFor, type Session } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// Real PostgreSQL + the production build (scratch resources only; helpers.ts refuses anything else). TRUST_PROXY=1 in this
// harness, so a fresh x-forwarded-for per request gives every request its own rate-limit IP unless a test pins one.

const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const newEmail = () => `cust.${randomUUID().slice(0, 10)}@test.example`;
const body = (over: Record<string, unknown> = {}) => {
  const email = newEmail();
  return { name: "Test Customer", email, password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD, ...captchaFields(), ...over };
};

async function register(payload: unknown, opts: { ip?: string; origin?: string | null; contentType?: string | null; raw?: string; keepToken?: boolean } = {}) {
  // A CAPTCHA ticket works once, so a test that submits one body repeatedly gets a fresh, correct ticket and answer each time.
  if (!opts.keepToken && payload && typeof payload === "object") payload = { ...payload, ...captchaFields() };
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? randIp() };
  if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  const res = await fetch(`${BASE}/api/auth/register`, { method: "POST", headers, body: opts.raw ?? JSON.stringify(payload) });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function page(p: string, s?: { cookie: string } | null) {
  const res = await fetch(`${BASE}${p}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {}, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}

const rows = (email: string) => db.user.findMany({ where: { email } });

async function registeredSession(): Promise<Session> {
  const b = body();
  assert.equal((await register(b)).status, 200);
  const l = await login(b.email);
  assert.equal(l.status, 200);
  const u = await db.user.findUniqueOrThrow({ where: { email: b.email } });
  return { cookie: l.cookie!, userId: u.id, email: b.email };
}

// ---- creation ---------------------------------------------------------------------
test("a valid registration creates one CUSTOMER account with a hashed password and nothing sensitive in the response", async () => {
  const b = body({ email: `  Mixed.Case.${randomUUID().slice(0, 8)}@Test.Example `, name: "  Ada   Lovelace " });
  const r = await register(b);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  for (const secret of [STRONG_PASSWORD, "passwordHash", "$2"]) assert.ok(!r.text.includes(secret), `response must not contain ${secret}`);

  const email = b.email.trim().toLowerCase();
  const found = await rows(email);
  assert.equal(found.length, 1);
  const u = found[0];
  assert.equal(u.name, "Ada Lovelace");
  assert.equal(u.role, "CUSTOMER");
  assert.equal(u.permissions, "[]");
  assert.equal(u.active, true);
  assert.equal(u.managerId, null);
  assert.equal(u.hourlyRateMinor, null);
  assert.match(u.passwordHash, /^\$2[aby]\$12\$/, "bcrypt, cost 12");
  assert.notEqual(u.passwordHash, STRONG_PASSWORD);
  assert.ok(!u.passwordHash.includes(STRONG_PASSWORD));
});

test("a client cannot choose role, permissions, status or supervisor", async () => {
  const sup = await createUser("ADMIN");
  for (const evil of [
    { role: "SUPER_ADMIN" },
    { role: "ADMIN" },
    { role: "USER" },
    { permissions: ["staff.manage", "companies.view"] },
    { active: false },
    { isAdmin: true, isSuperAdmin: true },
    { managerId: sup.id },
    { hourlyRateMinor: 5000 },
    { id: "hijack" },
  ]) {
    const b = body(evil);
    assert.equal((await register(b)).status, 200);
    const u = await db.user.findUniqueOrThrow({ where: { email: b.email } });
    assert.equal(u.role, "CUSTOMER", JSON.stringify(evil));
    assert.equal(u.permissions, "[]");
    assert.equal(u.active, true);
    assert.equal(u.managerId, null);
    assert.equal(u.hourlyRateMinor, null);
    assert.notEqual(u.id, "hijack");
  }
});

test("invalid submissions are rejected with field errors and create nothing", async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["missing name", { name: "" }, "name"],
    ["missing email", { email: "" }, "email"],
    ["invalid email", { email: "not-an-email" }, "email"],
    ["weak password", { password: "password", confirmPassword: "password" }, "password"],
    ["short password", { password: "Ab1!", confirmPassword: "Ab1!" }, "password"],
    ["mismatch", { confirmPassword: "Different-Horse-Battery-42!" }, "confirmPassword"],
    ["markup in name", { name: "<b>x</b>" }, "name"],
    ["wrong types", { name: 5, email: ["a@b.co"], password: {}, confirmPassword: null }, "name"],
  ];
  for (const [label, over, field] of cases) {
    const b = body(over);
    const r = await register(b);
    assert.equal(r.status, 400, label);
    assert.ok(r.json.fieldErrors?.[field], `${label}: error on ${field}`);
    if (typeof b.email === "string") assert.equal((await rows(b.email.trim().toLowerCase())).length, 0, `${label}: no row`);
  }
  for (const raw of ["{not json", "[]", "null", '"str"', ""]) {
    assert.equal((await register(null, { raw })).status, 400, `raw ${raw}`);
  }
});

test("request hygiene: cross-origin, missing origin, wrong content type and oversized bodies are refused", async () => {
  const b = body();
  assert.equal((await register(b, { origin: "https://evil.example" })).status, 403);
  assert.equal((await register(b, { origin: null })).status, 403);
  assert.equal((await register(b, { contentType: "text/plain" })).status, 415);
  assert.equal((await register(b, { contentType: null })).status, 415);
  assert.equal((await register(null, { raw: JSON.stringify({ ...b, name: "x".repeat(20_000) }) })).status, 413);
  assert.equal((await rows(b.email)).length, 0);
});

// ---- duplicates -------------------------------------------------------------------
test("a duplicate email gets the identical response, creates no second row and never changes the existing account", async () => {
  const first = body();
  const a = await register(first);
  const originalHash = (await db.user.findUniqueOrThrow({ where: { email: first.email } })).passwordHash;
  const dup = await register({ ...first, name: "Someone Else", password: "Another-Strong-Pass-77!", confirmPassword: "Another-Strong-Pass-77!" });
  const upper = await register({ ...first, email: first.email.toUpperCase() });
  for (const r of [dup, upper]) {
    assert.equal(r.status, a.status);
    assert.equal(r.text, a.text, "same body whether or not the address is registered");
  }
  const found = await rows(first.email);
  assert.equal(found.length, 1);
  assert.equal(found[0].passwordHash, originalHash);
  assert.equal(found[0].name, "Test Customer");
  assert.equal((await login(first.email, "Another-Strong-Pass-77!")).status, 401, "the duplicate's password does not work");
  assert.equal((await login(first.email)).status, 200, "the original password still works");
});

test("registering a staff member's email changes nothing about that staff account", async () => {
  const sa = await createUser("SUPER_ADMIN");
  const before = await db.user.findUniqueOrThrow({ where: { id: sa.id } });
  const r = await register(body({ email: sa.email, password: "Takeover-Attempt-88!", confirmPassword: "Takeover-Attempt-88!" }));
  assert.equal(r.status, 200);
  const after2 = await db.user.findUniqueOrThrow({ where: { id: sa.id } });
  assert.equal(after2.role, "SUPER_ADMIN");
  assert.equal(after2.passwordHash, before.passwordHash);
  assert.equal(after2.name, before.name);
  assert.equal((await login(sa.email, "Takeover-Attempt-88!")).status, 401);
  assert.equal((await login(sa.email)).status, 200);
});

test("parallel registrations of one address create exactly one account", async () => {
  const b = body();
  const results = await Promise.all(Array.from({ length: 4 }, () => register(b)));
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
  assert.equal((await rows(b.email)).length, 1);
});

// ---- abuse limits -----------------------------------------------------------------
test("repeated attempts for one address are rate limited (429 + Retry-After)", async () => {
  const b = body();
  const statuses: number[] = [];
  let last;
  for (let i = 0; i < 6; i++) {
    last = await register(b);
    statuses.push(last.status);
  }
  assert.deepEqual(statuses.slice(0, 4), [200, 200, 200, 200]);
  assert.equal(statuses[5], 429);
  assert.ok(Number(last!.headers.get("retry-after")) > 0);
  assert.equal((await rows(b.email)).length, 1);
});

test("one IP cannot create unlimited accounts (per-IP limit, behind a trusted proxy)", async () => {
  const ip = randIp();
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await register(body(), { ip })).status);
  assert.ok(statuses.slice(0, 10).every((s) => s === 200), statuses.join());
  assert.ok(statuses.slice(10).every((s) => s === 429), statuses.join());
  assert.equal((await register(body(), { ip: randIp() })).status, 200, "other addresses are unaffected");
});

// ---- sign-in and session ----------------------------------------------------------
test("a registered customer can sign in; wrong credentials are refused; the session carries the CUSTOMER role", async () => {
  const b = body();
  await register(b);
  assert.equal((await login(b.email, "Wrong-Password-123!")).status, 401);
  assert.equal((await login(`nobody.${randomUUID().slice(0, 6)}@test.example`)).status, 401);
  const ok = await login(b.email.toUpperCase());
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);
  const dash = await page("/dashboard", { cookie: ok.cookie! });
  assert.equal(dash.status, 200, "lands on the existing dashboard");
  const u = await db.user.findUniqueOrThrow({ where: { email: b.email }, include: { sessions: true } });
  assert.equal(u.sessions.length, 1, "a tracked session row was created");
  assert.ok(u.lastLoginAt);
});

test("a deactivated customer cannot sign in", async () => {
  const b = body();
  await register(b);
  await db.user.update({ where: { email: b.email }, data: { active: false } });
  assert.equal((await login(b.email)).status, 401);
});

// ---- routing ----------------------------------------------------------------------
test("/register is public (no redirect loop); signed-in visitors are sent to the dashboard; protected pages still require sign-in", async () => {
  const pub = await page("/register");
  assert.equal(pub.status, 200);
  assert.match(pub.text, /Create your free account/);
  assert.match(pub.text, /href="\/login"/);
  const s = await registeredSession();
  const signedIn = await page("/register", s);
  assert.equal(signedIn.status, 307);
  assert.match(signedIn.location ?? "", /\/dashboard$/);

  const loginPage = await page("/login");
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /href="\/register"/);

  for (const p of ["/dashboard", "/admin", "/users", "/companies"]) {
    const r = await page(p);
    assert.equal(r.status, 307, p);
    assert.match(r.location ?? "", /\/login\?next=/);
  }
});

// ---- a customer is not staff --------------------------------------------------------
test("a customer is refused every staff, administration and CMS API (company data and reports are allowed in Phase One: customer-phase-one.test.ts)", async () => {
  const s = await registeredSession();
  const target = await createUser("USER");
  const calls: [string, string, unknown?][] = [
    ["GET", "/api/users"],
    ["POST", "/api/users", { name: "x", email: newEmail(), password: STRONG_PASSWORD, role: "SUPER_ADMIN" }],
    ["PATCH", `/api/users/${s.userId}`, { role: "SUPER_ADMIN" }],
    ["PATCH", `/api/users/${target.id}`, { active: false }],
    ["GET", "/api/admin/website-content"],
    ["PUT", "/api/admin/website-content/draft", {}],
    ["POST", "/api/admin/website-content/publish", {}],
    ["GET", "/api/admin/columns"],
    ["GET", "/api/staff/report"],
    ["GET", "/api/timesheets"],
    ["POST", "/api/assignments", { assigneeId: s.userId, companyId: "x" }],
  ];
  for (const [method, path, payload] of calls) {
    const r = await api(s, path, { method, body: payload });
    assert.ok([401, 403, 404, 400, 405].includes(r.status) && r.status !== 200, `${method} ${path} -> ${r.status}`);
    assert.ok(r.status !== 200 && r.status !== 201, `${method} ${path} must not succeed`);
  }
  // None of that changed anything.
  const me = await db.user.findUniqueOrThrow({ where: { id: s.userId } });
  assert.equal(me.role, "CUSTOMER");
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.id } })).active, true);
});

test("a customer cannot open staff or Super Admin pages", async () => {
  const s = await registeredSession();
  for (const p of ["/admin", "/admin/staff", "/admin/website-content", "/admin/columns", "/users", "/work", "/work/timesheets", "/website-preview", "/website-preview/editor"]) {
    const r = await page(p, s);
    assert.ok([307, 308, 403, 404].includes(r.status), `${p} must not render for a customer (status ${r.status})`);
  }
});

// ---- regression: staff flows ---------------------------------------------------------
test("regression: a Super Admin still creates staff accounts with roles and permissions, and they can sign in", async () => {
  const sa = await sessionFor("SUPER_ADMIN");
  const email = newEmail();
  const r = await api(sa, "/api/users", { body: { name: "New Staff", email, password: STRONG_PASSWORD, role: "ADMIN" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.user.role, "ADMIN");
  assert.ok(!JSON.stringify(r.json).includes("passwordHash"));
  assert.equal((await login(email)).status, 200);

  const user = await api(sa, "/api/users", { body: { name: "New User", email: newEmail(), password: STRONG_PASSWORD } });
  assert.equal(user.status, 200);
  assert.equal(user.json.user.role, "USER");
  assert.ok(JSON.parse(user.json.user.permissions).includes("companies.view"), "staff USER keeps its permission set");
});

test("regression: a USER keeps company access; an Admin cannot elevate anyone", async () => {
  const user = await sessionFor("USER");
  assert.equal((await page("/companies", user)).status, 200);
  const admin = await sessionFor("ADMIN");
  assert.equal((await api(admin, "/api/users", { body: { name: "x", email: newEmail(), password: STRONG_PASSWORD, role: "SUPER_ADMIN" } })).status, 403);
});

test("a Super Admin can see and deactivate a customer from the existing Users screen API", async () => {
  const sa = await sessionFor("SUPER_ADMIN");
  const b = body();
  await register(b);
  const c = await db.user.findUniqueOrThrow({ where: { email: b.email } });
  const list = await api(sa, "/api/users");
  const mine = list.json.users.find((u: { id: string }) => u.id === c.id);
  assert.equal(mine?.role, "CUSTOMER");
  assert.ok(!JSON.stringify(list.json).includes("passwordHash"));
  assert.equal((await api(sa, `/api/users/${c.id}`, { method: "PATCH", body: { active: false } })).status, 200);
  assert.equal((await login(b.email)).status, 401);
});

// ---- human check (built-in numeric CAPTCHA; no external service) -------------------------------------------------------
const noAccount = async (b: { email: string }, label: string) => assert.equal((await rows(b.email.toLowerCase())).length, 0, `${label}: no account created`);

test("numeric CAPTCHA: a correct answer registers the customer (no Cloudflare Turnstile is configured or needed)", async () => {
  const b = body();
  const r = await register(b);
  assert.equal(r.status, 200, r.text);
  assert.equal((await rows(b.email)).length, 1);
});

test("numeric CAPTCHA: missing, empty, wrong, non-numeric, forged and oversized answers or tickets are refused and create nothing", async () => {
  const good = captchaFields();
  const wrong = String((Number(good.captchaAnswer) + 1) % 100000).padStart(5, "0");
  const cases: [string, Record<string, unknown>, string][] = [
    ["no ticket and no answer", { captchaToken: undefined, captchaAnswer: undefined }, "missing"],
    ["empty answer", { ...captchaFields(), captchaAnswer: "   " }, "missing"],
    ["answer not a string", { ...captchaFields(), captchaAnswer: 12345 }, "missing"],
    ["wrong answer", { ...captchaFields(), captchaAnswer: wrong }, "invalid"],
    ["non-numeric answer", { ...captchaFields(), captchaAnswer: "abcde" }, "invalid"],
    ["forged ticket", { captchaToken: "forged.ticket.value", captchaAnswer: "12345" }, "invalid"],
    ["ticket signed for a different answer", { captchaToken: good.captchaToken, captchaAnswer: wrong }, "invalid"],
    ["oversized ticket", { captchaToken: "x".repeat(3000), captchaAnswer: "12345" }, "invalid"],
    ["old Turnstile field only", { captchaToken: undefined, captchaAnswer: undefined, turnstileToken: "ok-anything" }, "missing"],
  ];
  for (const [label, over, reason] of cases) {
    const b = body(over);
    const r = await register(b, { keepToken: true });
    assert.equal(r.status, 400, label);
    assert.equal(r.json.captcha, reason, label);
    assert.ok(typeof r.json.error === "string" && r.json.error.length > 10, `${label}: a clear message`);
    await noAccount(b, label);
  }
});

test("numeric CAPTCHA: an expired challenge is refused (even with the right answer) and creates nothing", async () => {
  const b = body({ ...captchaFields(Date.now() - 6 * 60 * 1000) });
  const r = await register(b, { keepToken: true });
  assert.equal(r.status, 400);
  assert.equal(r.json.captcha, "expired");
  await noAccount(b, "expired");
  // Just inside the lifetime still works.
  const ok = body({ ...captchaFields(Date.now() - 4 * 60 * 1000) });
  assert.equal((await register(ok, { keepToken: true })).status, 200);
});

test("numeric CAPTCHA: a challenge works once - replaying a used one, or retrying after a wrong guess on it, is refused", async () => {
  const f = captchaFields();
  const first = body({ ...f });
  assert.equal((await register(first, { keepToken: true })).status, 200);
  const replay = body({ ...f });
  const r = await register(replay, { keepToken: true });
  assert.equal(r.status, 400);
  assert.equal(r.json.captcha, "used");
  await noAccount(replay, "replay");

  // One ticket allows one guess: a wrong answer burns it, so the right answer afterwards cannot be tried on the same ticket.
  const g = captchaFields();
  const wrongTry = body({ ...g, captchaAnswer: g.captchaAnswer === "11111" ? "22222" : "11111" });
  assert.equal((await register(wrongTry, { keepToken: true })).json.captcha, "invalid");
  const rightLater = body({ ...g });
  const r2 = await register(rightLater, { keepToken: true });
  assert.equal(r2.json.captcha, "used");
  await noAccount(rightLater, "guess then right");
});

test("numeric CAPTCHA: parallel attempts with one ticket let at most one through", async () => {
  const f = captchaFields();
  const bodies = Array.from({ length: 5 }, () => body({ ...f }));
  const results = await Promise.all(bodies.map((b) => register(b, { keepToken: true })));
  assert.ok(results.filter((r) => r.status === 200).length <= 1, "never more than one success");
  const created = (await Promise.all(bodies.map((b) => rows(b.email)))).flat().length;
  assert.ok(created <= 1);
});

test("numeric CAPTCHA: the challenge endpoint issues a fresh signed ticket and an image each time, never the answer, and is not cacheable", async () => {
  const get = () => fetch(`${BASE}/api/auth/captcha`, { headers: { "x-forwarded-for": randIp() } });
  const a = await get();
  assert.equal(a.status, 200);
  assert.match(a.headers.get("cache-control") ?? "", /no-store/);
  const ja = await a.json();
  const jb = await (await get()).json();
  assert.deepEqual(Object.keys(ja).sort(), ["expiresAt", "image", "ticket"], "nothing else (in particular no answer) is returned");
  assert.notEqual(ja.ticket, jb.ticket, "refresh gives a new challenge");
  assert.notEqual(ja.image, jb.image);
  assert.match(ja.image, /^data:image\/svg\+xml;base64,/);
  assert.ok(ja.expiresAt > Date.now() && ja.expiresAt <= Date.now() + 5 * 60 * 1000 + 1000, "short lifetime");
  const svg = Buffer.from(ja.image.split(",")[1], "base64").toString("utf8");
  assert.ok(svg.startsWith("<svg") && !/<script|onload|javascript:/i.test(svg), "a plain image with no script");
});

test("numeric CAPTCHA: issuing challenges is rate limited per IP", async () => {
  const ip = randIp();
  let blocked: Response | null = null;
  for (let i = 0; i < 50 && !blocked; i++) {
    const r = await fetch(`${BASE}/api/auth/captcha`, { headers: { "x-forwarded-for": ip } });
    if (r.status === 429) blocked = r;
  }
  assert.ok(blocked, "429 after too many requests from one address");
  assert.ok(Number(blocked!.headers.get("retry-after")) > 0);
  // Another address is unaffected.
  assert.equal((await fetch(`${BASE}/api/auth/captcha`, { headers: { "x-forwarded-for": randIp() } })).status, 200);
});

test("the register page has the numeric CAPTCHA field and no Cloudflare Turnstile", async () => {
  const html = await (await fetch(`${BASE}/register`)).text();
  assert.ok(html.includes("register-captcha"), "numeric CAPTCHA field is part of the page");
  assert.ok(!/turnstile|cf-turnstile|challenges\.cloudflare\.com\/turnstile/i.test(html), "no Turnstile widget or script");
  assert.ok(!html.includes("Registration is temporarily unavailable"), "registration does not depend on any third-party keys");
});
