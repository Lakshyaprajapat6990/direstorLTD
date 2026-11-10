import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { BASE, STRONG_PASSWORD, db, login, sessionFor, type Session } from "./helpers";
import { marketingEligibility } from "../../src/lib/customer/marketing-eligibility";

after(async () => {
  await db.$disconnect();
});

// Customer Settings (saved/edit state in the server-rendered page), consent persistence, and the Super Admin Customers screens,
// against the production build and a scratch PostgreSQL. No message is sent anywhere: the application has no sender to call.
const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function call(s: Session | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": randIp(), origin: BASE };
  if (s) headers.cookie = `director_session=${s.cookie}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text, location: res.headers.get("location") };
}
const page = (s: Session, path: string) => fetch(`${BASE}${path}`, { headers: { cookie: `director_session=${s.cookie}` }, redirect: "manual" });

async function customer(name = "Casey Rivers"): Promise<Session & { id: string }> {
  const email = `cs.${randomUUID().slice(0, 10)}@test.example`;
  const u = await db.user.create({ data: { email, name, passwordHash: await bcrypt.hash(STRONG_PASSWORD, 4), role: "CUSTOMER", permissions: "[]" } });
  const l = await login(email);
  assert.ok(l.cookie);
  return { cookie: l.cookie!, userId: u.id, id: u.id, email };
}
const DETAILS = { title: "Dr", firstName: "Ada", middleName: "Augusta", surname: "Lovelace", businessName: "Analytical Engines Ltd", address1: "12 Saint James Square", address2: "Floor 3", address3: "Westminster", town: "London", state: "Greater London", country: "GB", postcode: "SW1Y 4JH", phone: "07700 900123" };

test("Settings starts in EDIT for a customer with nothing saved and in SAVED (read-only) for one with details, field order unchanged", async () => {
  const c = await customer();
  let html = await (await page(c, "/settings")).text();
  assert.ok(html.includes('id="details-title"') && html.includes("Save changes") && !html.includes('data-testid="details-edit"'), "nothing saved: the form is open");
  assert.equal((await call(c, "PUT", "/api/profile/details", DETAILS)).status, 200);
  html = await (await page(c, "/settings")).text();
  assert.ok(html.includes('data-testid="details-edit"') && html.includes(">Edit<"), "saved: an Edit button");
  assert.ok(!html.includes('id="details-title"') && !html.includes('id="details-firstName"'), "saved: no input fields are rendered");
  assert.ok(html.includes(">Saved<"), "saved: it says so");
  const order = ["title", "firstName", "middleName", "surname", "businessName", "phone", "address1", "address2", "address3", "town", "state", "country", "postcode"];
  const at = order.map((f) => html.indexOf(`data-field="${f}"`));
  assert.ok(at.every((n) => n > 0) && at.every((n, i) => i === 0 || n > at[i - 1]), "the fields appear in the required order");
  for (const v of ["Ada", "Augusta", "Lovelace", "Analytical Engines Ltd", "+447700900123", "Westminster", "Greater London", "United Kingdom", "SW1Y 4JH"]) assert.ok(html.includes(v), `shows ${v}`);
});

test("country and state / county are stored separately; a non-UK country accepts its own postcode and region; address 3 lands in the existing column", async () => {
  const c = await customer();
  const r = await call(c, "PUT", "/api/profile/details", { ...DETAILS, country: "US", state: "California", town: "Los Angeles", postcode: "90210", phone: "+1 310 555 0100", address3: "Suite 9" });
  assert.equal(r.status, 200, r.text);
  const row = await db.customerProfile.findUniqueOrThrow({ where: { userId: c.id } });
  assert.deepEqual([row.country, row.state, row.postcode, row.phone], ["US", "California", "90210", "+13105550100"]);
  assert.equal((row as unknown as Record<string, string>).address4, "Suite 9", "address 3 is stored in the address4 column (the established mapping)");
  const uk = await call(c, "PUT", "/api/profile/details", { ...DETAILS, country: "GB", postcode: "90210" });
  assert.equal(uk.status, 400, "a UK address still needs a UK-shaped postcode");
  assert.ok(uk.json.fieldErrors.postcode);
  const after = await db.customerProfile.findUniqueOrThrow({ where: { userId: c.id } });
  assert.equal(after.country, "US", "a refused save changes nothing");
});

test("consent: independent per channel, off by default, recorded in the database against the right customer with wording version and time; withdrawal is its own row", async () => {
  const a = await customer();
  const b = await customer();
  assert.equal(await db.consentRecord.count({ where: { userId: { in: [a.id, b.id] } } }), 0, "no consent rows exist for a new customer");
  await call(a, "PUT", "/api/profile/details", DETAILS);

  assert.equal((await call(a, "POST", "/api/profile/consent", { channel: "email", granted: true })).status, 200);
  let st = (await call(a, "GET", "/api/profile/consent")).json.state;
  assert.equal(st.email.granted, true);
  assert.equal(st.sms.granted, false, "allowing email never allows SMS");
  assert.equal(await db.consentRecord.count({ where: { userId: a.id, channel: "sms" } }), 0);

  assert.equal((await call(a, "POST", "/api/profile/consent", { channel: "sms", granted: true })).status, 200);
  assert.equal((await call(a, "POST", "/api/profile/consent", { channel: "email", granted: false })).status, 200);
  st = (await call(a, "GET", "/api/profile/consent")).json.state;
  assert.deepEqual([st.email.granted, st.sms.granted], [false, true], "withdrawing email leaves SMS as it was");

  const rows = await db.consentRecord.findMany({ where: { userId: a.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(rows.map((r) => `${r.channel}:${r.granted}`), ["email:true", "sms:true", "email:false"], "history is preserved and the withdrawal is a separate row");
  for (const r of rows) {
    assert.equal(r.userId, a.id);
    assert.equal(r.version, "2026-10-draft-1");
    assert.ok(r.wording.includes("DIRECTOR.LTD") && r.source === "settings");
    assert.ok(Math.abs(Date.now() - r.createdAt.getTime()) < 60_000, "the timestamp is when it was done");
  }
  assert.equal(await db.consentRecord.count({ where: { userId: b.id } }), 0, "another customer is untouched");
  const hist = (await call(a, "GET", "/api/profile/consent")).json.history as { channel: string; granted: boolean }[];
  assert.deepEqual(hist.map((h) => `${h.channel}:${h.granted}`), ["email:false", "sms:true", "email:true"], "the page's history is read from those rows");
});

test("the server-side marketing check: yes only for a current grant; withdrawn, never, staff and deactivated are all no", async () => {
  const c = await customer();
  await call(c, "PUT", "/api/profile/details", DETAILS);
  assert.deepEqual(await marketingEligibility(c.id, "email"), { eligible: false, channel: "email", reason: "never_consented" });
  await call(c, "POST", "/api/profile/consent", { channel: "email", granted: true });
  const yes = await marketingEligibility(c.id, "email");
  assert.equal(yes.eligible, true);
  assert.equal((await marketingEligibility(c.id, "sms")).eligible, false, "SMS is still no");
  await call(c, "POST", "/api/profile/consent", { channel: "email", granted: false });
  assert.deepEqual(await marketingEligibility(c.id, "email"), { eligible: false, channel: "email", reason: "withdrawn" });
  await call(c, "POST", "/api/profile/consent", { channel: "sms", granted: true });
  assert.equal((await marketingEligibility(c.id, "sms")).eligible, true);
  await db.user.update({ where: { id: c.id }, data: { active: false } });
  assert.deepEqual(await marketingEligibility(c.id, "sms"), { eligible: false, channel: "sms", reason: "inactive" });
  const staff = await sessionFor("USER", "mk");
  await db.consentRecord.create({ data: { userId: staff.userId, channel: "email", granted: true, version: "x", wording: "x", source: "settings" } });
  assert.deepEqual(await marketingEligibility(staff.userId, "email"), { eligible: false, channel: "email", reason: "not_customer" });
});

test("Super Admin Customers: only a Super Admin can open the list or a customer, and it shows the stored details, separate consent statuses and the real history", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "cu");
  const admin = await sessionFor("ADMIN", "cu");
  const user = await sessionFor("USER", "cu");
  const c = await customer("Zed Customer");
  const other = await customer("Other Customer");
  await call(c, "PUT", "/api/profile/details", DETAILS);
  await call(c, "POST", "/api/profile/consent", { channel: "email", granted: true });
  await call(c, "POST", "/api/profile/consent", { channel: "sms", granted: true });
  await call(c, "POST", "/api/profile/consent", { channel: "sms", granted: false });

  for (const [who, s] of [["admin", admin], ["staff user", user], ["customer", c]] as const) {
    for (const path of ["/admin/customers", `/admin/customers/${c.id}`]) {
      const r = await page(s, path);
      assert.ok(r.status === 307 || r.status === 302 || r.status === 303, `${who} ${path}: redirected (${r.status})`);
      // (Next puts the signed-in person's own layout in a redirect body, so check for someone ELSE's data and for the screen's content.)
      const body = await r.text();
      assert.ok(!body.includes(c.email === s.email ? other.email : c.email) && !body.includes("Marketing permissions") && !body.includes("Consent history"), `${who} ${path}: shows no customer data`);
    }
  }
  assert.ok([307, 302, 303].includes((await fetch(`${BASE}/admin/customers`, { redirect: "manual" })).status), "signed out: redirected");

  const list = await (await page(sa, "/admin/customers")).text();
  assert.ok(list.includes(c.email) && list.includes("Ada Lovelace") && list.includes("+447700900123"), "the list shows name, email, phone");
  assert.ok(list.includes("Marketing emails") && list.includes("Marketing texts"));
  const search = await (await page(sa, `/admin/customers?q=${encodeURIComponent(c.email)}`)).text();
  assert.ok(search.includes(c.email));
  assert.ok(!(await (await page(sa, "/admin/customers?q=zzz-nobody-matches-this")).text()).includes(c.email), "search filters");

  const res = await page(sa, `/admin/customers/${c.id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Ada Lovelace") && html.includes(c.email) && html.includes("+447700900123") && html.includes("SW1Y 4JH") && html.includes("Westminster"));
  const chan = (name: string) => new RegExp(`data-channel="${name}"[\\s\\S]*?data-eligible="(yes|no)"`).exec(html)!;
  assert.equal(chan("email")[1], "yes", "email: allowed -> may be contacted");
  assert.equal(chan("sms")[1], "no", "SMS: withdrawn -> must not be");
  assert.ok(/data-channel="sms"[\s\S]*?Withdrawn/.test(html));
  assert.equal((html.match(/data-testid="consent-row"/g) ?? []).length, 3, "the history rows are the three real records");
  assert.ok(html.includes('href="tel:+447700900123"') && html.includes("does not place, record or log calls"), "a plain tel: link, with the honest explanation");
  assert.ok(!/<form[^>]*>[^]*?(send|Send)[^]*?<\/form>/.test(html.replace(/<form[^>]*role="search"[\s\S]*?<\/form>/, "")), "no send form exists");

  assert.equal((await page(sa, `/admin/customers/${(await sessionFor("USER", "cu")).userId}`)).status, 404, "a staff id is not a customer");
  assert.equal((await page(sa, "/admin/customers/not-an-id")).status, 404);
});

test("removing the phone number withdraws SMS marketing and records it; the Super Admin sees that withdrawal", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "cu2");
  const c = await customer();
  await call(c, "PUT", "/api/profile/details", DETAILS);
  await call(c, "POST", "/api/profile/consent", { channel: "sms", granted: true });
  await call(c, "PUT", "/api/profile/details", { ...DETAILS, phone: "" });
  assert.equal((await marketingEligibility(c.id, "sms")).eligible, false);
  const rows = await db.consentRecord.findMany({ where: { userId: c.id, channel: "sms" }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(rows.map((r) => [r.granted, r.source]), [[true, "settings"], [false, "phone_removed"]]);
  const html = await (await page(sa, `/admin/customers/${c.id}`)).text();
  assert.ok(html.includes("Phone number removed by the customer"));
});
