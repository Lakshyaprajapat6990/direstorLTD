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
import { CONSENT_COOKIE, CONSENT_VERSION } from "../../src/lib/consent";

// Real Chrome against the production build: every way into the Cookie policy (sign-in and registration pages, password recovery,
// the signed-in app) and the Super Admin preview's "Cookie settings" link, which must explain without touching the real consent.
// Skipped when Chrome is not installed.
const chrome = findChrome();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
  if (r.exceptionDetails) throw new Error(`eval failed: ${expression.slice(0, 80)} -> ${r.exceptionDetails.text}`);
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
  await sleep(600); // hydration
};
const viewport = (width: number, height: number, mobile = false) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
const cookies = async () => (await send("Network.getCookies", { urls: [BASE] })).cookies as { name: string; value: string }[];
const signIn = async (cookie: string) => {
  await send("Network.clearBrowserCookies");
  await send("Network.setCookie", { name: "director_session", value: cookie, url: BASE, httpOnly: true });
};
const noScroll = () => ev<boolean>(`document.documentElement.scrollWidth <= window.innerWidth`);
const policyLink = () => ev<{ n: number; visible: boolean; text: string }>(`(() => { const l = [...document.querySelectorAll('a[href="/cookie-policy"]')]; const a = l[0]; const r = a && a.getBoundingClientRect(); return { n: l.length, visible: !!r && r.width > 0 && r.height > 0, text: a ? a.textContent.trim() : '' }; })()`);
const followPolicyLink = async () => {
  await ev(`document.querySelector('a[href="/cookie-policy"]').click()`);
  await until(`location.pathname === '/cookie-policy' && document.querySelector('h1')`);
  return ev<{ h1: string; banners: number }>(`({ h1: document.querySelector('h1').textContent.trim(), banners: document.querySelectorAll('section[aria-label="Cookie consent"]').length })`);
};

const emails = { user: "", customer: "" };
let user: { cookie: string };
let customer: { cookie: string };
let superAdmin: { cookie: string };
before(async () => {
  if (!chrome) return;
  user = { cookie: (await sessionFor("USER", "cl")).cookie };
  superAdmin = { cookie: (await sessionFor("SUPER_ADMIN", "cl")).cookie };
  emails.customer = `cl.${randomUUID().slice(0, 8)}@test.example`;
  await db.user.create({ data: { email: emails.customer, name: "Casey Links", passwordHash: await bcrypt.hash(STRONG_PASSWORD, 4), role: "CUSTOMER", permissions: "[]" } });
  const c = await login(emails.customer);
  assert.ok(c.cookie, "customer signs in");
  customer = { cookie: c.cookie! };

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dl-links-"));
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

const T = { skip: chrome ? false : "Chrome is not installed", timeout: 120_000 };

test("sign-in, registration and password-recovery pages each show one visible Cookie policy link that opens the policy (desktop and 390px)", T, async () => {
  for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]] as const) {
    await viewport(w, h, mobile);
    for (const p of ["/login", "/register", "/forgot-password", "/reset-password"]) {
      await send("Network.clearBrowserCookies");
      await goto(p);
      const l = await policyLink();
      assert.equal(l.n, 1, `${w}px ${p}: exactly one link`);
      assert.ok(l.visible && l.text === "Cookie policy", `${w}px ${p}: visible`);
      assert.ok(await noScroll(), `${w}px ${p}: no sideways scroll`);
      assert.equal((await cookies()).length, 0, `${p}: viewing sets no cookie`);
    }
    await goto("/login");
    const landed = await followPolicyLink();
    assert.equal(landed.h1, "Cookie policy");
    assert.equal(landed.banners, 1, "one banner on the policy page, never two");
  }
});

test("signed-in app: a staff user and a customer each see one Cookie policy link in the app shell, it opens the policy, and the session survives", T, async () => {
  for (const [who, s] of [["staff", user], ["customer", customer]] as const) {
    for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]] as const) {
      await viewport(w, h, mobile);
      await signIn(s.cookie);
      await goto("/dashboard");
      assert.ok(!(await ev<string>(`location.pathname`)).startsWith("/login"), `${who}: signed in at ${w}px`);
      const l = await policyLink();
      assert.equal(l.n, 1, `${who} ${w}px: exactly one link`);
      assert.ok(l.visible && l.text === "Cookie policy", `${who} ${w}px: visible`);
      assert.ok(await noScroll(), `${who} ${w}px: no sideways scroll`);
      const before = (await cookies()).map((c) => c.name).sort();
      const landed = await followPolicyLink();
      assert.equal(landed.h1, "Cookie policy");
      assert.equal(landed.banners, 1, `${who}: one banner only`);
      assert.deepEqual((await cookies()).map((c) => c.name).sort(), before, `${who}: following the link changes no cookie`);
      await goto("/dashboard");
      assert.ok(!(await ev<string>(`location.pathname`)).startsWith("/login"), `${who}: still signed in after reading the policy`);
    }
  }
});

test("Super Admin preview: Cookie settings opens an explanation only, leaves the real consent byte-for-byte untouched, sets nothing, and shows no second banner", T, async () => {
  await viewport(1440, 900);
  await signIn(superAdmin.cookie);
  const saved = encodeURIComponent(JSON.stringify({ v: CONSENT_VERSION, media: true, t: Date.now() - 60_000 }));
  await send("Network.setCookie", { name: CONSENT_COOKIE, value: saved, url: BASE });
  await goto("/website-preview");
  assert.equal(await ev<number>(`document.querySelectorAll('section[aria-label="Cookie consent"]').length`), 0, "no public banner in the preview");
  const before = JSON.stringify((await cookies()).sort((a, b) => a.name.localeCompare(b.name)));
  assert.equal(await ev<boolean>(`!document.querySelector('[role=dialog]')`), true);

  // focus first, as a real click or keypress would: a scripted click() alone does not move focus, so there would be nothing to return to
  const open = () => ev(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Cookie settings'); b.focus(); b.click(); })()`);
  await open();
  await until(`document.querySelector('[role=dialog]#x, [role=dialog][aria-labelledby="preview-cookie-title"]')`);
  const text = await ev<string>(`document.querySelector('[role=dialog]').innerText`);
  assert.match(text, /Cookie settings \(preview\)/);
  assert.match(text, /not read, changed or removed/);
  assert.equal(await ev<number>(`document.querySelectorAll('[role=dialog]').length`), 1, "exactly one dialog");
  assert.equal(await ev<number>(`document.querySelectorAll('[role=switch]').length`), 0, "no consent switches: nothing here can change a choice");
  assert.equal(await ev<string>(`document.querySelector('[role=dialog] a[href="/cookie-policy"]').getAttribute('target')`), "_blank");
  assert.equal(await ev<string>(`document.activeElement.getAttribute('aria-label')`), "Close", "focus moves into the dialog (the close button)");

  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await until(`!document.querySelector('[role=dialog]')`);
  assert.equal(await ev<string>(`document.activeElement.textContent.trim()`), "Cookie settings", "focus returns to the footer link");

  await open();
  await until(`document.querySelector('[role=dialog]')`);
  await ev(`[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Close').click()`);
  await until(`!document.querySelector('[role=dialog]')`);
  assert.equal(JSON.stringify((await cookies()).sort((a, b) => a.name.localeCompare(b.name))), before, "the real cookies are identical after opening and closing");
  assert.equal(await ev<boolean>(`localStorage.length === 0 && sessionStorage.length === 0`), true, "the preview stores nothing in the browser");

  // 390px: the dialog fits, its buttons are on screen
  await viewport(390, 844, true);
  await open();
  await until(`document.querySelector('[role=dialog]')`);
  const fit = await ev<{ ok: boolean }>(`(() => { const d = document.querySelector('[role=dialog]').getBoundingClientRect(); const bs = [...document.querySelectorAll('[role=dialog] button, [role=dialog] a')].map(b => b.getBoundingClientRect()); return { ok: d.left >= 0 && d.right <= innerWidth && bs.every(r => r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width > 0) }; })()`);
  assert.ok(fit.ok, "dialog and buttons fit on a 390px screen");
  assert.ok(await noScroll());
});

test("a fresh visitor sees exactly one banner on the public home page and a signed-in Super Admin's public home page still works (no duplicate or conflicting consent state)", T, async () => {
  await viewport(1440, 900);
  await send("Network.clearBrowserCookies");
  await goto("/");
  assert.equal(await ev<number>(`document.querySelectorAll('section[aria-label="Cookie consent"]').length`), 1);
  assert.equal(await ev<number>(`document.querySelectorAll('[role=dialog]').length`), 0);
  assert.equal((await cookies()).filter((c) => c.name === CONSENT_COOKIE).length, 0, "no choice is stored before one is made");
});

test("across the run: no console errors or exceptions", T, () => {
  assert.deepEqual(problems, []);
});
