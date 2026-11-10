import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { BASE, STRONG_PASSWORD, db, login, sessionFor } from "./helpers";
import { findChrome } from "../support/browser";

// Real Chrome against the production build: the customer's Saved / Edit experience, marketing choices through the real checkboxes,
// and the Super Admin Customers screens, at desktop and 390px. Skipped when Chrome is not installed.
const chrome = findChrome();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SHOTS = process.env.SHOTS_DIR;
let proc: ChildProcess | undefined;
let ws: WebSocket;
let nextId = 0;
const pending = new Map<number, (m: { result?: any; error?: any }) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
const problems: string[] = [];

const send = (method: string, params: object = {}) =>
  new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async <T = unknown>(expression: string): Promise<T> => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${expression.slice(0, 90)} -> ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
  return r.result.value as T;
};
const until = async (expression: string, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev<boolean>(`!!(${expression})`).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${expression}`);
};
const goto = async (p: string) => {
  await send("Page.navigate", { url: `${BASE}${p}` });
  await sleep(300);
  await until(`document.readyState === "complete"`);
  await sleep(700); // hydration
};
const viewport = (width: number, height: number, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
const signIn = async (cookie: string) => {
  await send("Network.clearBrowserCookies");
  await send("Network.setCookie", { name: "director_session", value: cookie, url: BASE, httpOnly: true });
};
const shot = async (name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, "base64"));
};
const noScroll = () => ev<boolean>(`document.documentElement.scrollWidth <= window.innerWidth`);
const clickBtn = (text: string) => ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) throw new Error('no button ${text}'); b.click(); })()`);
const setInput = (id: string, value: string) => ev(`(() => { const el = document.getElementById(${JSON.stringify(id)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
const inViewMode = () => ev<boolean>(`!!document.querySelector('[data-testid="details-edit"]') && !document.getElementById('details-firstName')`);
const viewText = (f: string) => ev<string>(`document.querySelector('[data-field="${f}"] dd').textContent.trim()`);

const DETAILS = { title: "Dr", firstName: "Ada", middleName: "Augusta", surname: "Lovelace", businessName: "Analytical Engines Ltd", address1: "12 Saint James Square", address2: "Floor 3", address3: "Westminster", town: "London", state: "Greater London", country: "GB", postcode: "SW1Y 4JH", phone: "07700 900123" };
const randIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function api(cookie: string, method: string, p: string, body?: unknown) {
  return fetch(`${BASE}${p}`, { method, headers: { "content-type": "application/json", origin: BASE, "x-forwarded-for": randIp(), cookie: `director_session=${cookie}` }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function newCustomer(name = "Casey Rivers") {
  const email = `cb.${randomUUID().slice(0, 10)}@test.example`;
  const u = await db.user.create({ data: { email, name, passwordHash: await bcrypt.hash(STRONG_PASSWORD, 4), role: "CUSTOMER", permissions: "[]" } });
  const l = await login(email);
  assert.ok(l.cookie);
  return { id: u.id, email, cookie: l.cookie! };
}
const profileRow = (id: string) => db.customerProfile.findUnique({ where: { userId: id } });

before(async () => {
  if (!chrome) return;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dl-cset-"));
  proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9353", `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let target: string | undefined;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const tabs = (await (await fetch("http://127.0.0.1:9353/json")).json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = tabs.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch { /* starting */ }
  }
  assert.ok(target, "Chrome did not start");
  ws = new WebSocket(target);
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); return; }
    if (d.method === "Runtime.exceptionThrown") problems.push("exception: " + (d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text));
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") problems.push("console.error: " + d.params.args.map((a: { value?: string; description?: string }) => a.value ?? a.description).join(" "));
  };
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
});
after(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  proc?.kill();
  await db.$disconnect();
});

const T = { skip: chrome ? false : "Chrome is not installed", timeout: 180_000 };

test("customer with saved details: Saved view, Edit, Cancel discards, Save returns to the Saved view with a message, and it all persists", T, async () => {
  const c = await newCustomer();
  assert.equal((await api(c.cookie, "PUT", "/api/profile/details", DETAILS)).status, 200);
  await viewport(1440, 900);
  await signIn(c.cookie);
  await goto("/settings");
  assert.ok(await inViewMode(), "opens read-only");
  assert.equal(await ev<number>(`document.querySelectorAll('#your-details input, #your-details select').length`), 0, "no input fields in the saved view");
  assert.match(await ev<string>(`document.querySelector('#your-details').innerText`), /Saved/);
  assert.equal(await viewText("firstName"), "Ada");
  assert.equal(await viewText("country"), "United Kingdom");
  assert.equal(await viewText("phone"), "+447700900123");
  assert.equal(await viewText("address3"), "Westminster");
  await shot("1-saved-view-1440");

  // Edit -> change -> Cancel: nothing is kept
  await clickBtn("Edit");
  await until(`document.getElementById('details-firstName')`);
  assert.equal(await ev<string>(`document.getElementById('details-firstName').value`), "Ada", "the form opens with the saved values");
  assert.equal(await ev<string>(`document.activeElement.id`), "details-title", "focus moves to the first field");
  await setInput("details-firstName", "Changed");
  await setInput("details-state", "Somewhere Else");
  await shot("2-edit-mode-1440");
  await clickBtn("Cancel");
  await until(`document.querySelector('[data-testid="details-edit"]')`);
  assert.equal(await viewText("firstName"), "Ada", "Cancel shows the saved value again");
  assert.equal((await profileRow(c.id))?.firstName, "Ada", "and nothing was written");
  await clickBtn("Edit");
  await until(`document.getElementById('details-firstName')`);
  assert.equal(await ev<string>(`document.getElementById('details-firstName').value`), "Ada", "reopening does not bring back the discarded text");

  // Edit -> change -> Save
  await setInput("details-firstName", "Zed");
  await setInput("details-state", "Surrey");
  await setInput("details-country", "FR");
  await setInput("details-postcode", "75001");
  await clickBtn("Save changes");
  await until(`document.querySelector('[data-testid="details-edit"]')`);
  assert.ok(await inViewMode(), "after saving it is the Saved view again");
  assert.match(await ev<string>(`document.querySelector('#your-details [role=status]').innerText`), /Your details have been saved\./);
  assert.equal(await viewText("firstName"), "Zed");
  assert.equal(await viewText("country"), "France");
  assert.equal(await viewText("state"), "Surrey", "State / county and Country are separate");
  const row = await profileRow(c.id);
  assert.deepEqual([row?.firstName, row?.state, row?.country, row?.postcode, row?.surname], ["Zed", "Surrey", "FR", "75001", "Lovelace"], "persisted; untouched fields kept");
  await shot("3-after-save-1440");

  // refresh, then a brand-new sign-in
  await goto("/settings");
  assert.equal(await viewText("firstName"), "Zed", "survives a refresh");
  const again = await login(c.email);
  await signIn(again.cookie!);
  await goto("/settings");
  assert.equal(await viewText("firstName"), "Zed", "survives signing out and in");
  assert.equal(await viewText("country"), "France");
});

test("a failed save keeps what the customer typed, shows why, and stays in Edit; a first-time customer starts in Edit and ends in the Saved view", T, async () => {
  const c = await newCustomer();
  await viewport(1440, 900);
  await signIn(c.cookie);
  await goto("/settings");
  assert.ok(await ev<boolean>(`!!document.getElementById('details-firstName') && !document.querySelector('[data-testid="details-edit"]')`), "nothing saved: opens in Edit");
  assert.equal(await ev<number>(`[...document.querySelectorAll('#your-details button')].filter(b => b.textContent.trim() === 'Cancel').length`), 1);
  await setInput("details-firstName", "Typed");
  await setInput("details-postcode", "NOT A POSTCODE !!");
  await clickBtn("Save changes");
  await until(`document.getElementById('details-postcode-error')`);
  assert.equal(await ev<string>(`document.getElementById('details-firstName').value`), "Typed", "validation error: entries kept");
  assert.equal(await profileRow(c.id), null, "nothing saved");

  // the network fails
  await ev(`window.__realFetch = window.fetch; window.fetch = () => Promise.reject(new TypeError('offline'))`);
  await setInput("details-postcode", "");
  await clickBtn("Save changes");
  await until(`document.querySelector('#your-details [role=alert]')`);
  assert.match(await ev<string>(`document.querySelector('#your-details [role=alert]').innerText`), /not saved.*still here/i);
  assert.equal(await ev<string>(`document.getElementById('details-firstName').value`), "Typed", "network failure: entries kept");
  // a server error
  await ev(`window.fetch = () => Promise.resolve(new Response(JSON.stringify({ error: 'Boom' }), { status: 500, headers: { 'content-type': 'application/json' } }))`);
  await clickBtn("Save changes");
  await until(`document.querySelector('#your-details [role=alert]').innerText.includes('Boom')`);
  assert.equal(await ev<string>(`document.getElementById('details-firstName').value`), "Typed", "server error: entries kept");
  assert.equal(await profileRow(c.id), null);

  await ev(`window.fetch = window.__realFetch`);
  await clickBtn("Save changes");
  await until(`document.querySelector('[data-testid="details-edit"]')`);
  assert.equal(await viewText("firstName"), "Typed");
  assert.equal((await profileRow(c.id))?.firstName, "Typed");
});

test("marketing choices through the real checkboxes: independent, saved to the database, history grows, withdrawal is a new entry", T, async () => {
  const c = await newCustomer();
  await api(c.cookie, "PUT", "/api/profile/details", DETAILS);
  await viewport(1440, 900);
  await signIn(c.cookie);
  await goto("/settings");
  const box = (label: string) => `[...document.querySelectorAll('#marketing label')].find(l => l.textContent.includes(${JSON.stringify(label)})).querySelector('input')`;
  assert.equal(await ev<boolean>(`${box("Marketing emails")}.checked || ${box("Marketing text messages")}.checked`), false, "both are off by default");
  await ev(`${box("Marketing emails")}.click()`);
  await until(`${box("Marketing emails")}.checked && !${box("Marketing emails")}.disabled`);
  assert.equal(await ev<boolean>(`${box("Marketing text messages")}.checked`), false, "email does not switch SMS on");
  let rows = await db.consentRecord.findMany({ where: { userId: c.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(rows.map((r) => `${r.channel}:${r.granted}`), ["email:true"]);
  await ev(`${box("Marketing text messages")}.click()`);
  await until(`${box("Marketing text messages")}.checked && !${box("Marketing text messages")}.disabled`);
  await ev(`${box("Marketing emails")}.click()`);
  await until(`!${box("Marketing emails")}.checked && !${box("Marketing emails")}.disabled`);
  rows = await db.consentRecord.findMany({ where: { userId: c.id }, orderBy: { createdAt: "asc" } });
  assert.deepEqual(rows.map((r) => `${r.channel}:${r.granted}`), ["email:true", "sms:true", "email:false"], "three real rows, withdrawal separate");
  assert.match(await ev<string>(`document.querySelector('#marketing').innerText`), /Your history of choices \(3\)/);
  await goto("/settings");
  assert.equal(await ev<boolean>(`${box("Marketing emails")}.checked`), false);
  assert.equal(await ev<boolean>(`${box("Marketing text messages")}.checked`), true, "choices survive a refresh");
  await shot("4-marketing-1440");
});

test("390px: Saved view, Edit form and marketing fit the screen with no sideways scroll and every button reachable", T, async () => {
  const c = await newCustomer();
  await api(c.cookie, "PUT", "/api/profile/details", DETAILS);
  await viewport(390, 844, true);
  await signIn(c.cookie);
  await goto("/settings");
  assert.ok(await noScroll(), "Saved view: no sideways scroll");
  const fits = (sel: string) => ev<boolean>(`[...document.querySelectorAll(${JSON.stringify(sel)})].every(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 0.5; })`);
  assert.ok(await fits("#your-details button, #your-details dd, #your-details dt"));
  await shot("5-saved-view-390");
  await clickBtn("Edit");
  await until(`document.getElementById('details-firstName')`);
  assert.ok(await noScroll(), "Edit form: no sideways scroll");
  assert.ok(await fits("#your-details input, #your-details select, #your-details button"));
  assert.equal(await ev<boolean>(`(() => { const s = [...document.querySelectorAll('#your-details button')].find(b => b.textContent.trim() === 'Save changes').getBoundingClientRect(); const x = [...document.querySelectorAll('#your-details button')].find(b => b.textContent.trim() === 'Cancel').getBoundingClientRect(); return s.width > 80 && x.width > 50 && s.height >= 36 && x.height >= 36; })()`), true, "both buttons are usable size");
  await shot("6-edit-390");
  await goto("/settings");
  assert.ok(await noScroll(), "marketing section: no sideways scroll");
});

test("Super Admin Customers at desktop and 390px: list, search, a customer's details, separate consent statuses and the real history", T, async () => {
  const sa = await sessionFor("SUPER_ADMIN", "cbu");
  const c = await newCustomer("Browser Customer");
  await api(c.cookie, "PUT", "/api/profile/details", DETAILS);
  await api(c.cookie, "POST", "/api/profile/consent", { channel: "email", granted: true });
  await api(c.cookie, "POST", "/api/profile/consent", { channel: "sms", granted: true });
  await api(c.cookie, "POST", "/api/profile/consent", { channel: "sms", granted: false });

  for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]] as const) {
    await viewport(w, h, mobile);
    await signIn(sa.cookie);
    await goto(`/admin/customers?q=${encodeURIComponent(c.email)}`);
    assert.match(await ev<string>(`document.body.innerText`), /Ada Lovelace/);
    assert.ok(await noScroll(), `${w}px list: the page itself does not scroll sideways (the table scrolls inside its own box)`);
    assert.equal(await ev<string>(`document.querySelector('nav[aria-label="Super Admin sections"] [aria-current=page]').textContent.trim()`), "Customers");
    await shot(`7-admin-list-${w}`);
    await ev(`[...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Ada Lovelace').click()`);
    await until(`location.pathname === '/admin/customers/${c.id}'`);
    await sleep(500);
    assert.ok(await noScroll(), `${w}px detail: no sideways scroll`);
    const txt = await ev<string>(`document.body.innerText`);
    for (const s of [c.email, "+447700900123", "SW1Y 4JH", "Westminster", "United Kingdom", "Marketing emails", "Marketing text messages (SMS)", "Consent history (3)"]) assert.ok(txt.toLowerCase().includes(s.toLowerCase()), `${w}px detail shows ${s}`);
    assert.equal(await ev<string>(`document.querySelector('[data-channel=email] [data-eligible]').dataset.eligible`), "yes");
    assert.equal(await ev<string>(`document.querySelector('[data-channel=sms] [data-eligible]').dataset.eligible`), "no");
    assert.equal(await ev<number>(`document.querySelectorAll('[data-testid=consent-row]').length`), 3);
    assert.equal(await ev<string>(`document.querySelector('[data-testid=manual-call]').getAttribute('href')`), "tel:+447700900123");
    await shot(`8-admin-detail-${w}`);
  }
});

test("across the run: no console errors or exceptions", T, () => {
  assert.deepEqual(problems, []);
});
