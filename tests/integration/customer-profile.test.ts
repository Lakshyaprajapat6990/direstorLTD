import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, STRONG_PASSWORD, captchaFields, db, login, sessionFor, type Session } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// Post-registration profile and marketing permissions, against the production build and a scratch PostgreSQL.
const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function call(s: Session | null, method: string, path: string, body?: unknown, origin: string | null = BASE) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": randIp() };
  if (origin) headers.origin = origin;
  if (s) headers.cookie = `director_session=${s.cookie}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await res.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

async function newCustomer(): Promise<Session> {
  const email = `prof.${randomUUID().slice(0, 10)}@test.example`;
  const r = await call(null, "POST", "/api/auth/register", { name: "Profile Tester", email, password: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD, ...captchaFields() });
  assert.equal(r.status, 200, r.text);
  const l = await login(email);
  assert.equal(l.status, 200);
  const u = await db.user.findUniqueOrThrow({ where: { email } });
  return { cookie: l.cookie!, userId: u.id, email };
}

const DETAILS = { title: "Dr", firstName: "Ada", middleName: "Augusta", surname: "Lovelace", businessName: "Analytical Engines Ltd", address1: "12 Saint James Square", address2: "Floor 3", address3: "Westminster", town: "London", state: "Greater London", country: "GB", postcode: "sw1y 4jh", phone: "07700 900123" };

test("registration still shows only the four basic fields plus the human check (no profile fields)", async () => {
  const html = await (await fetch(`${BASE}/register`)).text();
  for (const id of ["register-name", "register-email", "register-password", "register-confirmPassword"]) assert.ok(html.includes(id), id);
  for (const f of ["firstName", "surname", "businessName", "address1", "postcode", "phone", "marketing"]) assert.ok(!html.includes(`register-${f}`) && !html.includes(`details-${f}`), `no ${f} on the registration form`);
  assert.ok(html.includes("register-captcha"), "the numeric human check is on the form");
  assert.ok(!/turnstile|challenges.cloudflare/i.test(html), "no Cloudflare Turnstile on the form");
});

test("a new customer has no profile row and no consent rows, and the Settings page offers the optional sections unticked", async () => {
  const s = await newCustomer();
  assert.equal(await db.customerProfile.count({ where: { userId: s.userId } }), 0);
  assert.equal(await db.consentRecord.count({ where: { userId: s.userId } }), 0);
  const res = await fetch(`${BASE}/settings`, { headers: { cookie: `director_session=${s.cookie}` } });
  const html = await res.text();
  for (const id of ['id="your-details"', 'id="marketing"', "Marketing preferences"]) assert.ok(html.includes(id), id);
  for (const gone of ['id="security"', "Set up authenticator app", "two-factor sign-in)"]) assert.ok(!html.includes(gone), `removed: ${gone}`);
  assert.ok(!/type="checkbox"[^>]*checked/.test(html), "no marketing box is pre-ticked");
});

test("a customer saves their details; they persist across a fresh sign-in and are normalised", async () => {
  const s = await newCustomer();
  const put = await call(s, "PUT", "/api/profile/details", DETAILS);
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.values.postcode, "SW1Y 4JH");
  assert.equal(put.json.values.phone, "+447700900123");

  const again = await login(s.email);
  const s2: Session = { ...s, cookie: again.cookie! };
  const got = await call(s2, "GET", "/api/profile/details");
  assert.equal(got.status, 200);
  assert.equal(got.json.values.surname, "Lovelace");
  assert.equal(got.json.values.address3, "Westminster");
  assert.equal(got.json.values.phone, "+447700900123");
  const html = await (await fetch(`${BASE}/settings`, { headers: { cookie: `director_session=${s2.cookie}` } })).text();
  assert.ok(html.includes("Lovelace") && html.includes("Westminster"), "the Settings page loads the saved values");
  assert.equal(await db.customerProfile.count({ where: { userId: s.userId } }), 1);
});

test("editing updates in place (still one row), blank fields clear, and invalid input is refused with field errors and changes nothing", async () => {
  const s = await newCustomer();
  await call(s, "PUT", "/api/profile/details", DETAILS);
  const edit = await call(s, "PUT", "/api/profile/details", { ...DETAILS, surname: "King", businessName: "" });
  assert.equal(edit.status, 200);
  const row = await db.customerProfile.findUniqueOrThrow({ where: { userId: s.userId } });
  assert.equal(row.surname, "King");
  assert.equal(row.businessName, null);
  assert.equal(await db.customerProfile.count({ where: { userId: s.userId } }), 1);

  const bad = await call(s, "PUT", "/api/profile/details", { ...DETAILS, postcode: "NOPE", phone: "abc", firstName: "<b>" });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fieldErrors.postcode && bad.json.fieldErrors.phone && bad.json.fieldErrors.firstName);
  assert.equal((await db.customerProfile.findUniqueOrThrow({ where: { userId: s.userId } })).surname, "King", "a refused save changes nothing");
  assert.equal((await call(s, "PUT", "/api/profile/details", { ...DETAILS, country: "ZZ" })).status, 400);
  assert.equal((await call(s, "PUT", "/api/profile/details", {})).status, 200, "an empty form is valid: nothing is mandatory");
});

test("one customer can never read or change another's details or consent; the target is always the session user", async () => {
  const a = await newCustomer();
  const b = await newCustomer();
  await call(a, "PUT", "/api/profile/details", DETAILS);
  await call(a, "POST", "/api/profile/consent", { channel: "email", granted: true });

  const sneaky = await call(b, "PUT", "/api/profile/details", { ...DETAILS, surname: "Intruder", userId: a.userId, id: a.userId });
  assert.equal(sneaky.status, 200);
  const sneakyConsent = await call(b, "POST", "/api/profile/consent", { channel: "email", granted: false, userId: a.userId });
  assert.equal(sneakyConsent.status, 200);
  assert.equal((await db.customerProfile.findUniqueOrThrow({ where: { userId: a.userId } })).surname, "Lovelace", "A's details are untouched");
  const aConsent = await call(a, "GET", "/api/profile/consent");
  assert.equal(aConsent.json.state.email.granted, true, "A's consent is untouched");
  const bGet = await call(b, "GET", "/api/profile/details");
  assert.equal(bGet.json.values.surname, "Intruder");
  assert.ok(!bGet.text.includes("Lovelace"), "B never receives A's data");
  const bConsent = await call(b, "GET", "/api/profile/consent");
  assert.equal(bConsent.json.history.length, 0, "B's own history is B's alone (B never had a choice to change)");
  assert.equal(await db.customerProfile.count({ where: { surname: "Intruder" } }), 1);
});

test("the profile and consent APIs need a signed-in CUSTOMER, a same-origin JSON request, and refuse staff", async () => {
  const s = await newCustomer();
  for (const [m, p] of [["GET", "/api/profile/details"], ["PUT", "/api/profile/details"], ["GET", "/api/profile/consent"], ["POST", "/api/profile/consent"]] as const) {
    assert.equal((await call(null, m, p, m === "GET" ? undefined : {})).status, 401, `${m} ${p} anonymous`);
  }
  assert.equal((await call(s, "PUT", "/api/profile/details", {}, null)).status, 403, "no Origin header");
  assert.equal((await call(s, "PUT", "/api/profile/details", {}, "https://evil.example")).status, 403, "foreign Origin");
  assert.equal((await call(s, "POST", "/api/profile/consent", { channel: "email", granted: true }, "https://evil.example")).status, 403);
  const staff = await sessionFor("USER", "profile-staff");
  for (const [m, p] of [["GET", "/api/profile/details"], ["PUT", "/api/profile/details"], ["GET", "/api/profile/consent"], ["POST", "/api/profile/consent"]] as const) {
    assert.equal((await call(staff, m, p, m === "GET" ? undefined : {})).status, 403, `${m} ${p} as staff`);
  }
});

test("marketing consent: off by default, per channel, saved with wording/version/time, withdrawable, history kept", async () => {
  const s = await newCustomer();
  const start = await call(s, "GET", "/api/profile/consent");
  assert.equal(start.json.state.email.granted, false);
  assert.equal(start.json.state.sms.granted, false);

  const on = await call(s, "POST", "/api/profile/consent", { channel: "email", granted: true });
  assert.equal(on.status, 200);
  assert.equal(on.json.state.email.granted, true);
  assert.equal(on.json.state.sms.granted, false, "channels are independent");
  const rec = await db.consentRecord.findFirstOrThrow({ where: { userId: s.userId, channel: "email" } });
  assert.equal(rec.granted, true);
  assert.equal(rec.source, "settings");
  assert.match(rec.version, /^2026-/);
  assert.match(rec.wording, /marketing emails/);
  assert.ok(Math.abs(Date.now() - rec.createdAt.getTime()) < 60_000);

  await call(s, "POST", "/api/profile/consent", { channel: "email", granted: true });
  assert.equal(await db.consentRecord.count({ where: { userId: s.userId } }), 1, "repeating the same choice adds nothing");
  const off = await call(s, "POST", "/api/profile/consent", { channel: "email", granted: false });
  assert.equal(off.json.state.email.granted, false);
  assert.deepEqual((await db.consentRecord.findMany({ where: { userId: s.userId }, orderBy: { createdAt: "asc" } })).map((r) => r.granted), [true, false], "the grant is kept next to the withdrawal");
  assert.equal(off.json.history.length, 2);

  assert.equal((await call(s, "POST", "/api/profile/consent", { channel: "post", granted: true })).status, 400);
  assert.equal((await call(s, "POST", "/api/profile/consent", { channel: "email", granted: "yes" })).status, 400);
});

test("SMS marketing needs a saved phone number; removing the number withdraws it (recorded); editing other details never changes consent", async () => {
  const s = await newCustomer();
  const noPhone = await call(s, "POST", "/api/profile/consent", { channel: "sms", granted: true });
  assert.equal(noPhone.status, 409);
  assert.equal(await db.consentRecord.count({ where: { userId: s.userId } }), 0);

  await call(s, "PUT", "/api/profile/details", DETAILS);
  assert.equal((await call(s, "POST", "/api/profile/consent", { channel: "sms", granted: true })).status, 200);
  await call(s, "POST", "/api/profile/consent", { channel: "email", granted: true });

  const before = await db.consentRecord.count({ where: { userId: s.userId } });
  await call(s, "PUT", "/api/profile/details", { ...DETAILS, town: "Leeds" });
  assert.equal(await db.consentRecord.count({ where: { userId: s.userId } }), before, "an unrelated edit writes no consent record");
  const st = await call(s, "GET", "/api/profile/consent");
  assert.equal(st.json.state.sms.granted, true);
  assert.equal(st.json.state.email.granted, true);

  const rm = await call(s, "PUT", "/api/profile/details", { ...DETAILS, phone: "" });
  assert.equal(rm.json.smsConsentWithdrawn, true);
  const after = await call(s, "GET", "/api/profile/consent");
  assert.equal(after.json.state.sms.granted, false);
  assert.equal(after.json.state.email.granted, true);
  const last = await db.consentRecord.findFirstOrThrow({ where: { userId: s.userId, channel: "sms" }, orderBy: { createdAt: "desc" } });
  assert.equal(last.source, "phone_removed");
  assert.equal(await db.consentRecord.count({ where: { userId: s.userId, channel: "sms" } }), 2, "grant and withdrawal are both kept");
});

test("there is no SMS 2FA, SMS provider or authenticator app: a saved phone is never verified and sign-in needs only the password", async () => {
  const s = await newCustomer();
  await call(s, "PUT", "/api/profile/details", DETAILS);
  const row = await db.customerProfile.findUniqueOrThrow({ where: { userId: s.userId } });
  assert.equal(row.phoneVerifiedAt, null, "saving a number never marks it verified");
  for (const p of ["/api/profile/2fa", "/api/auth/2fa", "/api/auth/sms", "/api/profile/security", "/api/profile/security/enable", "/api/profile/security/disable", "/api/profile/security/recovery-codes", "/api/auth/login/2fa"]) assert.equal((await call(s, "POST", p, {})).status, 404, p);
  const html = await (await fetch(`${BASE}/settings`, { headers: { cookie: `director_session=${s.cookie}` } })).text();
  assert.ok(!/Set up authenticator app|Authenticator app \(|recovery code/i.test(html) && !html.includes('id="security"'), "no authenticator section in Settings");
  assert.ok(html.includes("Marketing preferences") && html.includes("Your details"), "the other Settings sections are still there");
  const l = await login(s.email);
  assert.equal(l.status, 200, "sign-in needs only the password");
  assert.deepEqual(Object.keys(l.body), ["ok"], "no second-step challenge in the response");
});

test("customer Settings has no Google Calendar card (the Calendar page and follow-ups work without it); staff Settings still has it", async () => {
  const s = await newCustomer();
  const html = await (await fetch(`${BASE}/settings`, { headers: { cookie: `director_session=${s.cookie}` } })).text();
  assert.ok(!/Google Calendar|Ask a Super Admin|Internal DIRECTOR\.LTD calendar|Not locked to one provider/.test(html), "no calendar connection card for a customer");
  assert.ok(html.includes("Your details") && html.includes("Marketing preferences"), "the other customer sections are unchanged");
  const cal = await fetch(`${BASE}/calendar`, { headers: { cookie: `director_session=${s.cookie}` }, redirect: "manual" });
  assert.equal(cal.status, 200, "the Calendar page itself is still available to a customer");
  const staff = await sessionFor("USER", "calstaff");
  const staffHtml = await (await fetch(`${BASE}/settings`, { headers: { cookie: `director_session=${staff.cookie}` } })).text();
  assert.ok(staffHtml.includes("Google Calendar") && staffHtml.includes("Internal DIRECTOR.LTD calendar"), "staff Settings is unchanged");
});

test("Settings: names are ordered First name, Middle name, Last name; the SMS box explains why it is off until a phone is saved, then the explanation goes", async () => {
  const s = await newCustomer();
  const page = async () => (await fetch(`${BASE}/settings`, { headers: { cookie: `director_session=${s.cookie}` } })).text();
  let html = await page();
  const at = (id: string) => html.indexOf(`id="details-${id}"`);
  assert.ok(at("title") > 0 && at("title") < at("firstName") && at("firstName") < at("middleName") && at("middleName") < at("surname") && at("surname") < at("businessName"), "Title, First name, Middle name, Last name, Business name");
  assert.ok(html.includes(">Last name<") && !html.includes(">Surname<"), "the visible label is Last name");
  assert.ok(html.includes("consent-sms-needs-phone") && html.includes("This box is switched off until you save a phone number"), "no phone: the page says why SMS is off");
  assert.equal((await call(s, "POST", "/api/profile/consent", { channel: "sms", granted: true })).status, 409, "the server refuses SMS consent without a saved phone");
  assert.equal(await db.consentRecord.count({ where: { userId: s.userId, channel: "sms" } }), 0, "and writes nothing");
  assert.equal((await call(s, "PUT", "/api/profile/details", { ...DETAILS })).status, 200);
  html = await page();
  assert.ok(!html.includes("consent-sms-needs-phone"), "a saved phone removes the explanation");
  assert.equal((await call(s, "POST", "/api/profile/consent", { channel: "sms", granted: true })).status, 200, "and SMS consent can now be given");
});

test("activity log records which fields changed, never their values", async () => {
  const s = await newCustomer();
  await call(s, "PUT", "/api/profile/details", DETAILS);
  const rows = await db.activityLog.findMany({ where: { userId: s.userId, action: "profile_updated" } });
  assert.equal(rows.length, 1);
  const meta = JSON.stringify(rows[0]);
  assert.ok(meta.includes("surname"));
  for (const secret of ["Lovelace", "07700", "447700", "Saint James", "SW1Y"]) assert.ok(!meta.includes(secret), `activity must not contain ${secret}`);
});
