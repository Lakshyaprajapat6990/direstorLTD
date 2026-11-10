import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { BASE, STRONG_PASSWORD, db, makeCompany, sessionFor } from "./helpers";
import { findChrome } from "../support/browser";

// The public search box, end to end in real Chrome against the production build on the scratch server: widget behaviour, the sign-in
// round trip that keeps the search, the filters the results page then applies, the free-account route, hostile return addresses, and the
// Corporate Structure illustration (motion, reduced motion, no outside requests). Skipped when Chrome is not installed.
const chrome = findChrome();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOST = new URL(BASE).host;
const TAG = `HSRCH${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

let proc: ChildProcess | undefined;
let ws: WebSocket;
let nextId = 0;
const pending = new Map<number, (m: { result?: any; error?: any }) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
const requests: string[] = [];
const problems: string[] = [];
const userIds: string[] = [];
let sa: { cookie: string; email: string };
let customerCookie = "";
const STRUCT_NUMBER = "00000000";
let structureName = "";

const send = (method: string, params: object = {}) =>
  new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async <T = unknown>(expression: string): Promise<T> => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${expression.slice(0, 80)} -> ${r.exceptionDetails.text}`);
  return r.result.value as T;
};
const until = async (expression: string, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev<boolean>(`!!(${expression})`).catch(() => false)) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for: ${expression}`);
};
const goto = async (p: string) => {
  await send("Page.navigate", { url: p.startsWith("http") ? p : `${BASE}${p}` });
  await sleep(300);
  await until(`document.readyState === "complete"`);
  await sleep(600); // hydration
};
const where = () => ev<string>(`location.pathname + location.search`);
const text = () => ev<string>(`document.body.innerText`);
const clickTab = (t: string) => ev<boolean>(`(() => { const b = [...document.querySelectorAll('[role=tab]')].find(x => x.textContent.trim() === ${JSON.stringify(t)}); if (!b) return false; b.click(); return true; })()`);
// React controls the inputs, so set values through the native setter and dispatch the events it listens for.
const setInput = (sel: string, value: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`);
const widgetInput = `#search input[type=search]`;
const selectByLabel = (label: string, value: string) => ev(`(() => { const l = [...document.querySelectorAll('#search label')].find(x => x.querySelector('.sr-only')?.textContent === ${JSON.stringify(label)}); const e = l.querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const pressEnter = async () => {
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
};
const signIn = async (email: string) => {
  await until(`document.querySelector('#login-email')`);
  await setInput("#login-email", email);
  await setInput("#login-password", STRONG_PASSWORD);
  await ev(`document.querySelector('#login-password').form.requestSubmit()`);
};
const logOut = async () => { await send("Network.clearBrowserCookies"); };
const thirdParty = () => requests.filter((u) => { try { const x = new URL(u); return !["data:", "blob:", "about:"].includes(x.protocol) && x.host !== HOST; } catch { return false; } });

before(async () => {
  if (!chrome) return;
  sa = await sessionFor("SUPER_ADMIN", "hsrch");
  userIds.push((await db.user.findFirstOrThrow({ where: { email: sa.email } })).id);
  const cust = await db.user.create({ data: { email: `hsrch.cust.${TAG.toLowerCase()}@test.example`, name: "Search Customer", passwordHash: await bcrypt.hash(STRONG_PASSWORD, 4), role: "CUSTOMER", permissions: "[]" } });
  userIds.push(cust.id);
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.7.7" }, body: JSON.stringify({ email: cust.email, password: STRONG_PASSWORD }) });
  customerCookie = r.headers.get("set-cookie")?.match(/director_session=([^;]+)/)?.[1] ?? "";
  assert.ok(customerCookie, "customer sign-in");
  // Real rows, so the results are real: only the filters decide which of these a search returns.
  await makeCompany({ name: `${TAG} ALPHA LTD`, type: "ltd", sicCodes: "98765" });
  await makeCompany({ name: `${TAG} BRAVO LLP`, type: "llp", sicCodes: "98765" });
  await makeCompany({ name: `${TAG} CHARLIE LTD`, type: "ltd", sicCodes: "98764", hasDS01: true });
  await makeCompany({ name: `${TAG} DELTA LTD`, type: "ltd", sicCodes: "98764", singleDirector: true, directorCount: 1, officersCoverage: "full" });
  await makeCompany({ name: `${TAG} ECHO LTD`, type: "ltd", sicCodes: "98764", directorCount: 3, officersCoverage: "full" });

  // A real-shaped register row the Corporate structure section can show: active, officers confirmed, the lowest company number.
  const fixture = await db.company.findUnique({ where: { companyNumber: STRUCT_NUMBER } });
  if (!fixture) await makeCompany({ companyNumber: STRUCT_NUMBER, name: `${TAG} STRUCTURE LTD`, officersCoverage: "full", directorCount: 2 });
  structureName = fixture ? fixture.name : `${TAG} STRUCTURE LTD`;
  for (let i = 0; i < 150 && !(await (await fetch(`${BASE}/`)).text()).includes(structureName); i++) await sleep(1000); // the homepage regenerates at most every 60 seconds
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dl-hsrch-"));
  proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9352", `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let target: string | undefined;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const tabs = (await (await fetch("http://127.0.0.1:9352/json")).json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = tabs.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch { /* starting */ }
  }
  assert.ok(target, "Chrome did not start");
  ws = new WebSocket(target);
  await new Promise<void>((r2) => (ws.onopen = () => r2()));
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); return; }
    if (d.method === "Network.requestWillBeSent") requests.push(d.params.request.url);
    if (d.method === "Runtime.exceptionThrown") problems.push("exception: " + (d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text));
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") problems.push("console.error: " + d.params.args.map((a: { value?: string; description?: string }) => a.value ?? a.description).join(" "));
  };
  for (const m of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(m);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
});
after(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  proc?.kill();
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.company.deleteMany({ where: { companyNumber: STRUCT_NUMBER, name: { startsWith: TAG } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  await db.$disconnect();
});

const T = { skip: chrome ? false : "Chrome is not installed", timeout: 180_000 };

test("the widget: each tab changes label, placeholder and rules; invalid input is refused on the page with nothing sent", T, async () => {
  await logOut();
  await goto("/");
  await until(`document.querySelector(${JSON.stringify(widgetInput)})`);
  const ph = async () => ev<string>(`document.querySelector(${JSON.stringify(widgetInput)}).placeholder`);
  const active = () => ev<string>(`[...document.querySelectorAll('#search [role=tab]')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.textContent.trim()).join()`);
  assert.equal(await active(), "Company search");
  assert.match(await ph(), /Company name, number or postcode/);
  await clickTab("SIC code");
  assert.equal(await active(), "SIC code");
  assert.match(await ph(), /SIC code/);
  await setInput(widgetInput, "62a0b1");
  assert.equal(await ev(`document.querySelector(${JSON.stringify(widgetInput)}).value`), "6201", "the SIC box takes digits only");
  await clickTab("Filings");
  assert.equal(await active(), "Filings");
  assert.ok(await ev(`!![...document.querySelectorAll('#search select')].find(s => [...s.options].some(o => o.text.includes('DS01')))`), "the filing position list appears");
  await clickTab("Directors");
  assert.ok(await ev(`!![...document.querySelectorAll('#search select')].find(s => [...s.options].some(o => /single/i.test(o.text)))`), "the director position list appears");
  // empty / too short / invalid: a visible message, focus in the box, and the page does not move
  for (const [tab, value, re] of [["Company search", "", /at least 2 characters/], ["Company search", "a", /at least 2 characters/], ["SIC code", "", /2 to 5 digits/], ["SIC code", "7", /2 to 5 digits/], ["Filings", "", /filing position/], ["Directors", "", /director position/]] as const) {
    await clickTab(tab);
    await setInput(widgetInput, value);
    await ev(`document.querySelector('#search button[aria-label=Search]').click()`);
    await until(`document.querySelector('#search [role=alert]')`);
    assert.match(await ev<string>(`document.querySelector('#search [role=alert]').textContent`), re, `${tab} "${value}"`);
    assert.equal(await where(), "/", "nothing was sent");
    assert.ok(await ev(`document.activeElement === document.querySelector(${JSON.stringify(widgetInput)})`), "focus returns to the box");
  }
  // only real choices are offered
  const countries = await ev<string[]>(`[...[...document.querySelectorAll('#search select')][0].options].map(o => o.text)`);
  assert.deepEqual(countries, ["United Kingdom"]);
});

test("signed out: a search by click goes to sign-in carrying the whole search; signing in resumes it with the filters applied to real results", T, async () => {
  await logOut();
  await goto("/");
  await until(`document.querySelector(${JSON.stringify(widgetInput)})`);
  await clickTab("SIC code");
  await setInput(widgetInput, "98765");
  await selectByLabel("Company type", "ltd");
  await ev(`document.querySelector('#search button[aria-label=Search]').click()`);
  await until(`location.pathname === '/login'`);
  const next = new URL(BASE + (await where())).searchParams.get("next")!;
  const n = new URL(next, "http://x");
  assert.equal(n.pathname, "/companies");
  assert.equal(n.searchParams.get("mode"), "sic");
  assert.equal(n.searchParams.get("sic"), "98765");
  assert.equal(n.searchParams.get("type"), "ltd");
  assert.ok(!/director_session|password|token/i.test(await where()), "no secret in the address");
  assert.equal(await ev(`JSON.stringify([localStorage.length, sessionStorage.length])`), "[0,0]", "nothing parked in browser storage");
  await signIn(sa.email);
  await until(`location.pathname === '/companies'`, 30_000);
  assert.equal(new URL(BASE + (await where())).searchParams.get("sic"), "98765", "the search came back after sign-in");
  await until(`document.body.innerText.includes(${JSON.stringify(TAG + " ALPHA LTD")})`, 30_000);
  const t = await text();
  assert.ok(t.includes(`${TAG} ALPHA LTD`), "SIC 98765 + Ltd finds ALPHA");
  assert.ok(!t.includes(`${TAG} BRAVO LLP`), "the LLP is excluded by the company type filter");
  assert.ok(!t.includes(`${TAG} CHARLIE LTD`) && !t.includes(`${TAG} DELTA LTD`), "other SIC codes are excluded");
});

test("signed in: Enter in the box goes straight to results for each mode, with the matching filters", T, async () => {
  await logOut();
  await send("Network.setCookie", { name: "director_session", value: sa.cookie, url: BASE });
  const run = async (tab: string, fill: (() => Promise<unknown>) | null, query: string, expectIn: string[], expectOut: string[]) => {
    await goto("/");
    await until(`document.querySelector(${JSON.stringify(widgetInput)})`);
    await clickTab(tab);
    await fill?.();
    await setInput(widgetInput, query);
    await ev(`document.querySelector(${JSON.stringify(widgetInput)}).focus()`);
    await pressEnter();
    await until(`location.pathname === '/companies'`);
    for (const e of expectIn) await until(`document.body.innerText.includes(${JSON.stringify(e)})`, 30_000);
    // the results settle (a result list replaces the previous one): wait for the excluded rows to be gone, never assume the timing
    for (const e of expectOut) await until(`!document.body.innerText.includes(${JSON.stringify(e)})`, 15_000).catch(async () => { throw new Error(`${tab}: ${e} still listed at ${await where()}: ${(await text()).slice(0, 1500)}`); });
    const t = await text();
    for (const e of expectIn) assert.ok(t.includes(e), `${tab}: ${e} present`);
    return where();
  };
  const has = (u: string, k: string, v: string | null) => assert.equal(new URL(u, BASE).searchParams.get(k), v, `${k} in ${u}`);
  const A = `${TAG} ALPHA LTD`, B = `${TAG} BRAVO LLP`, C = `${TAG} CHARLIE LTD`, D = `${TAG} DELTA LTD`, E = `${TAG} ECHO LTD`;
  const u1 = await run("Company search", null, TAG, [A, B, C, D, E], []);
  has(u1, "mode", "company"); has(u1, "q", TAG);
  await run("Company search", () => selectByLabel("Company type", "llp"), TAG, [B], [A, C, D, E]);
  has(await run("SIC code", null, "98764", [C, D, E], [A, B]), "sic", "98764");
  has(await run("Filings", () => selectByLabel("Filing position", "ds01"), TAG, [C], [A, B, D, E]), "filing", "ds01");
  await run("Directors", () => selectByLabel("Director position", "single"), TAG, [D], [A, B, C, E]);
  await run("Directors", () => selectByLabel("Director position", "multiple"), TAG, [E], [A, B, C, D]);
});

test("busy state: a second activation while a search is being sent is ignored", T, async () => {
  await goto("/");
  await until(`document.querySelector(${JSON.stringify(widgetInput)})`);
  await setInput(widgetInput, TAG);
  const r = await ev<{ submits: number; busy: string | null; disabled: boolean }>(`(async () => {
    const f = document.querySelector('#search form'); let n = 0; window.addEventListener('submit', (e) => { if (!e.defaultPrevented) n++; });
    const b = document.querySelector('#search button[aria-label=Search]'); b.click();
    await new Promise((r) => setTimeout(r, 0));
    const busy = f.getAttribute('aria-busy'); const disabled = b.disabled; b.click(); f.requestSubmit();
    return { submits: n, busy, disabled };
  })()`);
  assert.equal(r.submits, 1, "the second activation did not submit again");
  assert.equal(r.busy, "true");
  assert.equal(r.disabled, true, "the button is disabled while sending");
});

test("the results page still works on its own: ordinary ?q= search and no filters unless asked for", T, async () => {
  await goto(`/companies?q=${TAG}`);
  await until(`document.body.innerText.includes(${JSON.stringify(TAG + " ALPHA LTD")})`, 30_000);
  const t = await text();
  for (const n of ["ALPHA LTD", "BRAVO LLP", "CHARLIE LTD", "DELTA LTD", "ECHO LTD"]) assert.ok(t.includes(`${TAG} ${n}`), n);
  // hostile / unknown parameters are dropped, not applied
  await goto(`/companies?q=${TAG}&type=%3Cscript%3E&filing=evil&mode=admin`);
  await until(`document.body.innerText.includes(${JSON.stringify(TAG + " ALPHA LTD")})`, 30_000);
  assert.ok((await text()).includes(`${TAG} BRAVO LLP`), "an unknown type filters nothing out");
});

test("return addresses: only same-site paths are followed after sign-in", T, async () => {
  for (const evil of ["https://evil.example/x", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
    await logOut();
    await goto(`/login?next=${encodeURIComponent(evil)}`);
    await signIn(sa.email);
    await until(`location.pathname !== '/login'`, 30_000);
    const u = await ev<string>(`location.href`);
    assert.equal(new URL(u).host, HOST, `${evil} -> ${u}`);
    assert.equal(new URL(u).pathname, "/dashboard", evil);
  }
  await logOut();
  await goto(`/login?next=${encodeURIComponent("/companies?q=" + TAG)}`);
  await signIn(sa.email);
  await until(`location.pathname === '/companies'`, 30_000);
});

test("Phase One: a customer account uses the full UK Companies search (no redirect to a limited one); the old page forwards there", T, async () => {
  const get = (p: string) => fetch(`${BASE}${p}`, { redirect: "manual", headers: { cookie: `director_session=${customerCookie}` } });
  assert.equal((await get(`/companies?mode=sic&sic=98765&type=ltd`)).status, 200);
  assert.equal((await get(`/companies?q=${TAG}`)).status, 200);
  const old = await get(`/find-companies?q=${TAG}`);
  assert.ok([302, 303, 307, 308].includes(old.status), String(old.status));
  assert.match(old.headers.get("location") ?? "", /\/companies\?q=/);
});

test("Corporate Structure: renders honestly, is responsive, animates only when motion is allowed, and loads nothing from outside", T, async () => {
  await logOut();
  requests.length = 0;
  await goto("/");
  await until(`document.querySelector('.cs-root')`);
  await ev(`document.querySelector('.cs-root').scrollIntoView({ block: 'center' })`);
  await sleep(1500);
  const t = await ev<string>(`document.querySelector('.cs-root').innerText`);
  for (const s of ["Real company record", "Selected company", "Company number", structureName, STRUCT_NUMBER, "Parent company", "Subsidiaries", "Beneficial owners", "Ownership data: DNL", "no relationship is shown or implied"]) assert.ok(t.includes(s), s);
  assert.ok(!/Example (Holdings|Trading|Services|Property|Person)/.test(t), "no invented names");
  assert.ok((t.match(/DNL/g) ?? []).length >= 4, "DNL in the header and in each of the three slots");
  assert.ok(!/Not available|No verified/.test(t), "the earlier wording is gone");
  assert.ok(await ev(`document.querySelectorAll('.cs-root .cs-card').length === 4`), "the company and three unavailable slots");
  // motion allowed: entrance + travelling highlight run
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await goto("/");
  await ev(`document.querySelector('.cs-root').scrollIntoView({ block: 'center' })`);
  await until(`document.querySelector('.cs-root').getAttribute('data-inview') === 'true'`);
  const anim = await ev<{ node: string; flow: string }>(`({ node: getComputedStyle(document.querySelector('.cs-node')).animationName, flow: getComputedStyle(document.querySelector('.cs-hline'), '::after').animationName })`);
  assert.ok(anim.flow.includes("cs-flow-x"), `travelling highlight runs: ${anim.flow}`);
  assert.ok(anim.node.includes("cs-in"), `entrance runs: ${anim.node}`);
  // reduced motion: nothing animates and nothing is hidden
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await goto("/");
  await ev(`document.querySelector('.cs-root').scrollIntoView({ block: 'center' })`);
  await sleep(1200);
  const still = await ev<{ names: string[]; opacity: string[] }>(`({ names: [...document.querySelectorAll('.cs-root .cs-node, .cs-root .cs-line')].flatMap(e => [getComputedStyle(e).animationName, getComputedStyle(e, '::after').animationName]), opacity: [...document.querySelectorAll('.cs-root .cs-node')].map(e => getComputedStyle(e).opacity) })`);
  assert.ok(still.names.every((n) => n === "none"), `no animation under reduced motion: ${still.names.join()}`);
  assert.ok(still.opacity.every((o) => o === "1"), "all nodes visible");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  // no layout shift of the diagram's box while it enters, and it fits a phone with no sideways scroll
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await goto("/");
  const h0 = await ev<number>(`Math.round(document.querySelector('.cs-root').getBoundingClientRect().height)`);
  await ev(`document.querySelector('.cs-root').scrollIntoView({ block: 'center' })`);
  await sleep(2500);
  assert.equal(await ev<number>(`Math.round(document.querySelector('.cs-root').getBoundingClientRect().height)`), h0, "height unchanged by the entrance");
  assert.equal(await ev<boolean>(`document.documentElement.scrollWidth > document.documentElement.clientWidth`), false, "no horizontal scroll on a phone");
  assert.ok(await ev<boolean>(`[...document.querySelectorAll('.cs-root .cs-card')].every(c => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })`), "every card is inside the screen");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(thirdParty(), [], `no outside requests: ${thirdParty().join(", ")}`);
});

test("no script errors across all of the above", T, () => {
  assert.deepEqual(problems, []);
});
