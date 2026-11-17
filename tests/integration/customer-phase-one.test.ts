import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, STRONG_PASSWORD, captchaFields, api, db, group, login, makeCompany, rule, sessionFor, type Session } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// Phase One: a self-registered customer has the platform features of a normal user (search, Advanced Search, reports, exports, CRM,
// calendar) and none of the administration, and only ever sees their own private records. Real PostgreSQL + the production build.
// The trailing "X" makes the tag 9 characters so it can never look like an 8-character company number (two letters + six digits,
// which search looks up exactly instead of by name): 6 random hex characters are all digits about 6% of the time.
const tag = `P1${randomUUID().slice(0, 6).toUpperCase()}X`;

async function registeredCustomer(): Promise<Session> {
  const email = `phase1.${randomUUID().slice(0, 10)}@test.example`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ name: "Phase Customer", email, password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD, ...captchaFields() }),
  });
  assert.equal(res.status, 200, await res.text());
  const l = await login(email);
  assert.equal(l.status, 200);
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  assert.equal(u.role, "CUSTOMER");
  return { cookie: l.cookie!, userId: u.id, email };
}

async function page(p: string, s: Session) {
  const res = await fetch(`${BASE}${p}`, { headers: { cookie: `director_session=${s.cookie}` }, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}
const get = (s: Session, path: string) => fetch(`${BASE}${path}`, { headers: { cookie: `director_session=${s.cookie}` }, redirect: "manual" });

const names = ["Alpha", "Beta", "Gamma"];
const companyIds: string[] = [];
async function ensureCompanies() {
  if (companyIds.length) return;
  for (const n of names) companyIds.push((await makeCompany({ name: `${tag} ${n} Ltd`, status: "active" })).id);
  companyIds.push((await makeCompany({ name: `${tag} Delta Ltd`, status: "dissolved" })).id);
}

test("a new customer sees the full navigation and every platform page renders for them", async () => {
  const c = await registeredCustomer();
  const dash = await page("/dashboard", c);
  assert.equal(dash.status, 200);
  for (const gone of ["Not available on a free account", "Your free company views", "Welcome to DIRECTOR.LTD"]) assert.ok(!dash.text.includes(gone), `dashboard still shows: ${gone}`);
  for (const label of ["UK Companies", "Advanced Search", "Report Builder", "Saved Reports", "Watches", "Red flags", "Calendar", "Trash"]) assert.ok(dash.text.includes(label), `nav lacks ${label}`);
  for (const p of ["/companies", "/companies/advanced", "/reports", "/reports/new", "/watches", "/saved", "/red-flags", "/trash", "/calendar", "/settings"]) {
    assert.equal((await page(p, c)).status, 200, p);
  }
  // The old limited pages now hand over to the full tools.
  const old = await page("/find-companies?q=acme", c);
  assert.equal(old.status, 307);
  assert.match(old.location ?? "", /\/companies\?q=acme$/);
});

test("a customer is still refused every administrative page and API", async () => {
  const c = await registeredCustomer();
  const target = await sessionFor("USER");
  for (const p of ["/admin", "/admin/staff", "/admin/website-content", "/admin/columns", "/admin/activity", "/admin/timesheets", "/users", "/website-preview", "/website-preview/editor", "/work"]) {
    const r = await page(p, c);
    assert.ok([307, 308, 403, 404].includes(r.status), `${p} must not render for a customer (status ${r.status})`);
  }
  const calls: [string, string, unknown?][] = [
    ["GET", "/api/users"],
    ["POST", "/api/users", { name: "x", email: `x${randomUUID().slice(0, 6)}@test.example`, password: STRONG_PASSWORD, role: "SUPER_ADMIN" }],
    ["PATCH", `/api/users/${c.userId}`, { role: "SUPER_ADMIN" }],
    ["PATCH", `/api/users/${c.userId}`, { permissions: ["staff.manage"] }],
    ["PATCH", `/api/users/${target.userId}`, { active: false }],
    ["GET", "/api/admin/website-content"],
    ["PUT", "/api/admin/website-content/draft", {}],
    ["GET", "/api/admin/columns"],
    ["GET", "/api/staff/report"],
    ["GET", "/api/timesheets"],
    ["POST", "/api/assignments", { assigneeId: c.userId, companyId: "x" }],
  ];
  for (const [method, path, body] of calls) {
    const r = await api(c, path, { method, body });
    assert.ok([400, 401, 403, 404, 405].includes(r.status), `${method} ${path} -> ${r.status}`);
  }
  const me = await db.user.findUniqueOrThrow({ where: { id: c.userId } });
  assert.equal(me.role, "CUSTOMER");
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: target.userId } })).active, true);
});

test("search, filters (including ANY / OR) and director filters work for a customer", async () => {
  await ensureCompanies();
  const c = await registeredCustomer();
  const plain = await api(c, "/api/companies/search", { body: { q: tag } });
  assert.equal(plain.status, 200, plain.text);
  assert.equal(plain.json.rows.length, 4);
  const andFilter = await api(c, "/api/companies/search", { body: { filter: group("AND", rule("name", "startsWith", tag), rule("status", "equals", "active")) } });
  assert.equal(andFilter.status, 200, andFilter.text);
  assert.equal(andFilter.json.rows.length, 3);
  const orFilter = await api(c, "/api/companies/search", { body: { filter: group("OR", rule("name", "contains", `${tag} Alpha`), rule("name", "contains", `${tag} Beta`)) } });
  assert.equal(orFilter.status, 200, orFilter.text);
  assert.equal(orFilter.json.rows.length, 2);
  const directors = await api(c, "/api/companies/search", { body: { filter: group("AND", rule("name", "startsWith", tag), rule("directorCount", "gte", 0)) } });
  assert.notEqual(directors.status, 403, directors.text);
});

test("reports: create, list, open, edit, export (CSV, PDF, Word), delete - all on the customer's own report", async () => {
  await ensureCompanies();
  const c = await registeredCustomer();
  const filter = group("AND", rule("name", "startsWith", tag), rule("status", "equals", "active"));
  const created = await api(c, "/api/reports", { body: { name: `Mine ${tag}`, filter, dailyRefresh: false, columns: ["name", "companyNumber", "status"] } });
  assert.equal(created.status, 200, created.text);
  const id = created.json.report.id as string;

  const list = await api(c, "/api/reports");
  assert.equal(list.status, 200);
  assert.ok(list.json.reports.some((r: { id: string }) => r.id === id));
  assert.equal((await page(`/reports/${id}`, c)).status, 200);

  const one = await api(c, `/api/reports/${id}`);
  assert.equal(one.status, 200, one.text);

  const renamed = await api(c, `/api/reports/${id}`, { method: "PATCH", body: { name: `Renamed ${tag}` } });
  assert.equal(renamed.status, 200, renamed.text);

  const docx = await get(c, `/api/reports/${id}/export?format=docx`);
  assert.equal(docx.status, 200);
  assert.match(docx.headers.get("content-type") ?? "", /wordprocessingml/);
  const pdf = await get(c, `/api/reports/${id}/export?format=pdf`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get("content-type") ?? "", /pdf/);
  const xlsx = await api(c, "/api/reports/export", { body: { format: "xlsx", filter } });
  assert.equal(xlsx.status, 200, xlsx.text.slice(0, 200));

  // Company-results CSV export: allowed with a filter, refused for the whole register (the same rule a normal user has).
  const filtered = await api(c, "/api/companies/export", { body: { filter } });
  assert.equal(filtered.status, 200, filtered.text.slice(0, 200));
  assert.ok(filtered.text.includes(`${tag} Alpha Ltd`), "the CSV carries the matching companies");
  const whole = await api(c, "/api/companies/export", { body: {} });
  assert.equal(whole.status, 403);
  const wholeDoc = await api(c, "/api/reports/export", { body: { filter: group("AND"), format: "pdf" } });
  assert.ok([400, 403].includes(wholeDoc.status), `unfiltered document export -> ${wholeDoc.status}`);

  assert.equal((await api(c, `/api/reports/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await api(c, `/api/reports/${id}`)).status, 404);
});

test("CRM: follow, save, flag, notes, follow-ups and director details work for a customer and stay private", async () => {
  await ensureCompanies();
  const a = await registeredCustomer();
  const b = await registeredCustomer();
  const company = companyIds[0];
  for (const patch of [{ followed: true }, { saved: true }, { redFlagged: true }]) {
    const r = await api(a, `/api/companies/${company}/state`, { body: patch });
    assert.equal(r.status, 200, JSON.stringify(patch) + r.text);
  }
  const note = await api(a, `/api/companies/${company}/notes`, { body: { body: "private to A" } });
  assert.equal(note.status, 200, note.text);
  const fu = await api(a, `/api/companies/${company}/followups`, { body: { dueDate: "2030-01-15", note: "call" } });
  assert.equal(fu.status, 200, fu.text);

  // The Watches / Saved / Red flags pages load these lists through the search API's scopes.
  for (const scope of ["followed", "saved", "redFlagged"]) {
    const mine = await api(a, "/api/companies/search", { body: { scope, q: tag } });
    assert.ok(mine.json.rows.some((r: { id: string }) => r.id === company), `${scope} lists A's company`);
    const theirs = await api(b, "/api/companies/search", { body: { scope, q: tag } });
    assert.equal(theirs.json.rows.length, 0, `${scope} is private: B sees nothing of A's`);
  }
  for (const p of ["/watches", "/saved", "/red-flags"]) assert.equal((await page(p, a)).status, 200, p);
  const detailB = await page(`/companies/${company}`, b);
  assert.equal(detailB.status, 200);
  assert.ok(!detailB.text.includes("private to A"), "B cannot see A's note");

  const noteId = (await db.note.findFirstOrThrow({ where: { body: "private to A" } })).id;
  assert.ok([403, 404].includes((await api(b, `/api/notes/${noteId}`, { method: "DELETE" })).status), "B cannot delete A's note");
  const fuId = (await db.followUp.findFirstOrThrow({ where: { userId: a.userId } })).id;
  assert.ok([403, 404].includes((await api(b, `/api/followups/${fuId}`, { method: "DELETE" })).status), "B cannot delete A's follow-up");
  assert.equal((await api(b, "/api/followups")).json.followUps?.some?.((f: { id: string }) => f.id === fuId) ?? false, false);
  assert.equal((await page("/calendar", a)).status, 200);
});

test("ownership: one customer cannot read, edit, delete, export or share another's report, and the listing is their own", async () => {
  await ensureCompanies();
  const a = await registeredCustomer();
  const b = await registeredCustomer();
  const staff = await sessionFor("USER");
  const filter = group("AND", rule("name", "startsWith", tag));
  const made = await api(a, "/api/reports", { body: { name: `A only ${tag}`, filter, dailyRefresh: false, columns: ["name"] } });
  assert.equal(made.status, 200, made.text);
  const id = made.json.report.id as string;

  for (const who of [b, staff]) {
    assert.ok([403, 404].includes((await api(who, `/api/reports/${id}`)).status), "read");
    assert.ok([403, 404].includes((await api(who, `/api/reports/${id}`, { method: "PATCH", body: { name: "hijack" } })).status), "edit");
    assert.ok([403, 404].includes((await api(who, `/api/reports/${id}`, { method: "DELETE" })).status), "delete");
    assert.ok([403, 404].includes((await get(who, `/api/reports/${id}/export?format=csv`)).status), "export");
    assert.ok([403, 404].includes((await api(who, `/api/reports/${id}/refresh`, { method: "POST" })).status), "refresh");
    assert.ok([403, 404].includes((await api(who, `/api/reports/${id}/share`, { body: { method: "link" } })).status), "share");
    assert.ok(![200].includes((await page(`/reports/${id}`, who)).status), "page");
  }
  const listB = await api(b, "/api/reports");
  assert.ok(!listB.json.reports.some((r: { id: string }) => r.id === id));
  assert.equal((await db.report.findUniqueOrThrow({ where: { id } })).name, `A only ${tag}`);
});
