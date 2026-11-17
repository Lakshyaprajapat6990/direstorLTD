import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, STRONG_PASSWORD, captchaFields, api, createUser, db, login, makeCompany, sessionFor, type Session } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// Real PostgreSQL + the production build on scratch resources only. The server runs with the default quota (10 different
// company profiles per free account, lifetime).
const LIMIT = 10;
// The trailing "X" makes the tag 9 characters: a search term of exactly 8 characters shaped like two letters + six digits is treated as a
// company NUMBER (exact lookup), and 6 random hex characters are all digits about 6% of the time, which made this test flaky.
const tag = `FT${randomUUID().slice(0, 6).toUpperCase()}X`;
const origin = { origin: BASE };

async function customer(): Promise<Session> {
  const bcrypt = (await import("bcryptjs")).default;
  const email = `free.${randomUUID().slice(0, 10)}@test.example`;
  const u = await db.user.create({ data: { email, name: "Free Customer", passwordHash: await bcrypt.hash(STRONG_PASSWORD, 4), role: "CUSTOMER", permissions: "[]" } });
  const l = await login(email);
  assert.equal(l.status, 200);
  return { cookie: l.cookie!, userId: u.id, email };
}

async function call(s: Session | null, path: string, body?: unknown, headers: Record<string, string> = origin) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, ...(s ? { cookie: `director_session=${s.cookie}` } : {}) },
    body: JSON.stringify(body ?? {}),
    redirect: "manual",
  });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}
const search = (s: Session | null, q: unknown) => call(s, "/api/customer/companies/search", { q });
const open = (s: Session | null, id: string, headers?: Record<string, string>) => call(s, `/api/customer/companies/${id}/open`, {}, headers);
async function page(p: string, s?: Session | null) {
  const res = await fetch(`${BASE}${p}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {}, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}
const used = (userId: string) => db.customerCompanyView.count({ where: { userId } });

const companies: { id: string; name: string }[] = [];
async function ensureCompanies() {
  if (companies.length) return;
  for (let i = 0; i < 14; i++) {
    const c = await makeCompany({ name: `${tag} Widgets ${String(i).padStart(2, "0")} Ltd`, registeredAddress1: `${100 + i} Quota Street`, registeredCity: "Quotaville", registeredPostcode: "QU1 1AA" });
    companies.push({ id: c.id, name: c.name });
  }
}

// ---- search -----------------------------------------------------------------------------------------------------------
test("search: needs a session, the CUSTOMER role and a same-origin JSON request", async () => {
  await ensureCompanies();
  const c = await customer();
  assert.equal((await search(null, tag)).status, 401);
  const staff = await sessionFor("USER");
  assert.equal((await search(staff, tag)).status, 403, "staff use the real search");
  assert.equal((await sessionFor("SUPER_ADMIN").then((s) => search(s, tag))).status, 403);
  const cross = await call(c, "/api/customer/companies/search", { q: tag }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  const noOrigin = await call(c, "/api/customer/companies/search", { q: tag }, {});
  assert.equal(noOrigin.status, 403);
  const text = await fetch(`${BASE}/api/customer/companies/search`, { method: "POST", headers: { origin: BASE, "content-type": "text/plain", cookie: `director_session=${c.cookie}` }, body: "{}" });
  assert.equal(text.status, 415);
});

test("search: short terms are refused; results are capped at 10 identity fields; postcode and filter tricks return nothing extra", async () => {
  await ensureCompanies();
  const c = await customer();
  for (const q of ["", "ab", "  a ", 5, null, { x: 1 }, "x".repeat(101)]) assert.equal((await search(c, q)).status, 400, JSON.stringify(q));

  const r = await search(c, tag);
  assert.equal(r.status, 200);
  assert.equal(r.json.rows.length, 10, "capped at 10 although 14 match");
  assert.deepEqual(Object.keys(r.json.rows[0]).sort(), ["companyNumber", "id", "name", "status", "type"], "identity fields only");
  assert.deepEqual(r.json.usage, { used: 0, limit: LIMIT, remaining: LIMIT });
  assert.ok(!r.text.includes("Quota Street") && !r.text.includes("QU1 1AA"));

  assert.equal((await search(c, "QU1 1AA")).json.rows.length, 0, "postcode search is not available");
  const extra = await call(c, "/api/customer/companies/search", { q: tag, page: 2, pageSize: 100, filter: { kind: "group" }, scope: "all" });
  assert.equal(extra.json.rows.length, 10, "page / size / filter parameters are ignored");
  assert.equal((await search(c, companies[3].name.toLowerCase())).json.rows[0]?.id, companies[3].id, "case-insensitive name match");
  const byNumber = await db.company.findUniqueOrThrow({ where: { id: companies[4].id } });
  assert.equal((await search(c, byNumber.companyNumber.toLowerCase())).json.rows[0]?.id, companies[4].id, "exact company number");
  assert.equal(await used(c.userId), 0, "searching never uses the allowance");
});

test("search: a per-account rate limit applies", async () => {
  await ensureCompanies();
  const c = await customer();
  let blocked = 0;
  for (let i = 0; i < 44; i++) if ((await search(c, tag)).status === 429) blocked++;
  assert.ok(blocked >= 3, `expected the 41st+ search to be refused, got ${blocked}`);
});


test("the allowance is exactly 10 different companies; the 11th is refused; opened ones stay available", async () => {
  await ensureCompanies();
  const c = await customer();
  for (let i = 0; i < LIMIT; i++) assert.equal((await open(c, companies[i].id)).status, 200, `open ${i}`);
  const eleventh = await open(c, companies[LIMIT].id);
  assert.equal(eleventh.status, 403);
  assert.equal(eleventh.json.usage.remaining, 0);
  assert.equal(await used(c.userId), LIMIT);
  assert.equal((await open(c, companies[0].id)).status, 200, "an already-opened company is still reachable");

});

test("parallel requests cannot exceed the allowance", async () => {
  await ensureCompanies();
  const c = await customer();
  const results = await Promise.all(companies.map((co) => open(c, co.id)));
  const okCount = results.filter((r) => r.status === 200).length;
  assert.equal(okCount, LIMIT, results.map((r) => r.status).join());
  assert.equal(results.filter((r) => r.status === 403).length, companies.length - LIMIT);
  assert.equal(await used(c.userId), LIMIT);

  const d = await customer();
  const same = await Promise.all(Array.from({ length: 6 }, () => open(d, companies[0].id)));
  assert.ok(same.every((r) => r.status === 200));
  assert.equal(await used(d.userId), 1, "the same company opened in parallel counts once");
});

test("usage is private to each customer and an unknown or malformed id cannot be opened", async () => {
  await ensureCompanies();
  const a = await customer();
  const b = await customer();
  await open(a, companies[1].id);
  assert.equal(await used(b.userId), 0);
  assert.equal((await open(b, "does-not-exist")).status, 404);
  assert.equal((await open(b, "bad id!")).status, 404);
  assert.equal(await used(b.userId), 0);
  // The client cannot name a user or a quota.
  const spoof = await call(b, `/api/customer/companies/${companies[2].id}/open`, { userId: a.userId, limit: 9999, used: -50 });
  assert.equal(spoof.status, 200);
  assert.equal(await used(b.userId), 1);
  assert.equal(await used(a.userId), 1);
});

test("staff and Super Admin are unaffected: they cannot use the free API, create usage rows, or lose their normal pages", async () => {
  await ensureCompanies();
  for (const role of ["USER", "ADMIN", "SUPER_ADMIN"] as const) {
    const s = await sessionFor(role);
    assert.equal((await open(s, companies[0].id)).status, 403, role);
    assert.equal(await used(s.userId), 0);
    const redirect = await page("/find-companies", s);
    assert.equal(redirect.status, 307);
    assert.match(redirect.location ?? "", /\/companies$/);
  }
  const user = await sessionFor("USER");
  const real = await api(user, "/api/companies/search", { body: { q: tag } });
  assert.equal(real.status, 200);
  assert.ok(real.json.rows.length >= 14, "staff search still returns everything, unlimited");
  assert.equal((await page(`/companies/${companies[5].id}`, user)).status, 200);
  assert.equal(await db.customerCompanyView.count({ where: { userId: user.userId } }), 0);
});


test("the homepage has the Create Your Free Account button linking to /register, and the existing buttons are intact", async () => {
  const home = await page("/");
  assert.equal(home.status, 200);
  assert.match(home.text, /<a[^>]+href="\/register"[^>]*>[\s\S]{0,400}?Create Your Free Account/);
  assert.match(home.text, /href="\/login"/);
  assert.ok(home.text.includes("Explore UK data"));
  assert.ok(home.text.includes("Sign in"));
  const reg = await page("/register");
  assert.equal(reg.status, 200);
  assert.match(reg.text, /href="\/login"/);
  assert.match((await page("/login")).text, /href="\/register"/);
});

// ---- password rule through the real APIs -----------------------------------------------------------------------------
test("password rule: the reported failure is fixed on the Create user API and registration, and weak passwords stay refused", async () => {
  const sa = await sessionFor("SUPER_ADMIN");
  const email = `horse.${randomUUID().slice(0, 6)}@test.example`;
  const fine = await api(sa, "/api/users", { body: { name: "Horse Lee", email, password: "Correct-Horse-Battery-42!" } });
  assert.equal(fine.status, 200, JSON.stringify(fine.json));

  const personal = await api(sa, "/api/users", { body: { name: "Jane Smith", email: `jane.smith.${randomUUID().slice(0, 4)}@test.example`, password: "JaneSmith-2026!" } });
  assert.equal(personal.status, 400);
  assert.match(personal.json.error, /name or email/);
  const nameOnly = await api(sa, "/api/users", { body: { name: "Wajid Ahmed", email: `x${randomUUID().slice(0, 6)}@test.example`, password: "Wajid-2026-ab!" } });
  assert.equal(nameOnly.status, 400);
  assert.equal((await api(sa, "/api/users", { body: { name: "Weak", email: `w${randomUUID().slice(0, 6)}@test.example`, password: "password123" } })).status, 400);

  const reg = await call(null, "/api/auth/register", { name: "Horse Lee", email: `horse.${randomUUID().slice(0, 6)}@test.example`, password: "Correct-Horse-Battery-42!", confirmPassword: "Correct-Horse-Battery-42!", ...captchaFields() }, { origin: BASE, "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  assert.equal(reg.status, 200);
  const bad = await call(null, "/api/auth/register", { name: "Jane Smith", email: `jane.smith.${randomUUID().slice(0, 4)}@test.example`, password: "JaneSmith-2026!", confirmPassword: "JaneSmith-2026!", ...captchaFields() }, { origin: BASE, "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fieldErrors.password);
  // A staff account created with the corrected rule can sign in.
  assert.equal((await login(email, "Correct-Horse-Battery-42!")).status, 200);
  void createUser;
});

