import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE, db, login, sessionFor, type Session } from "./helpers";
import { findChrome } from "../support/browser";
import { toEditable, type EditableContent } from "../../src/lib/site-content/schema";
import { DEFAULT_SITE_CONTENT } from "../../src/lib/site-content/defaults";
import { newSection } from "../../src/lib/site-content/editor-model";
import { CONSENT_COOKIE, CONSENT_VERSION } from "../../src/lib/consent";

// Real Chrome against the production build on the scratch server. Named zz-* so it runs after the CMS suites (it publishes a video
// section). YouTube / Vimeo requests are intercepted and answered with a stub, so the test sees that the browser TRIED to load a
// player without any real traffic leaving the machine. Skipped when Chrome is not installed.
const chrome = findChrome();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOST = new URL(BASE).host;
const DAY = 86_400_000;

let proc: ChildProcess | undefined;
let ws: WebSocket;
let nextId = 0;
const pending = new Map<number, (m: { result?: any; error?: any }) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
const requests: string[] = [];
const stubbed: string[] = [];
const problems: string[] = [];

const send = (method: string, params: object = {}, sessionId?: string) =>
  new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const id = ++nextId;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const PLAYER_PATTERNS = [{ urlPattern: "*youtube-nocookie.com*" }, { urlPattern: "*player.vimeo.com*" }];
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
  await send("Page.navigate", { url: p.startsWith("http") ? p : `${BASE}${p}` });
  await sleep(300);
  await until(`document.readyState === "complete"`);
  await sleep(500); // hydration
};
const clickText = (text: string) => ev<boolean>(`(() => { const e = [...document.querySelectorAll('button,a')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!e) return false; e.click(); return true; })()`);
const bannerShown = () => ev<boolean>(`!!document.querySelector('section[aria-label="Cookie consent"]')`);
const toggleOn = () => ev<boolean>(`document.querySelector('[role=switch]').checked`);
const iframes = () => ev<number>(`document.querySelectorAll('iframe').length`);
const placeholder = () => ev<boolean>(`document.body.innerText.includes('This video is hosted by')`);
const consentRecord = async () => {
  const jar = await send("Network.getCookies", { urls: [BASE] });
  const c = (jar.cookies as { name: string; value: string }[]).find((x) => x.name === CONSENT_COOKIE);
  return c ? { raw: c.value, ...JSON.parse(decodeURIComponent(c.value)) } : null;
};
const cookieNames = async () => ((await send("Network.getCookies", { urls: [BASE] })).cookies as { name: string }[]).map((c) => c.name);
const setConsentCookie = (value: string) => send("Network.setCookie", { name: CONSENT_COOKIE, value, url: BASE });
const freshVisit = async (p = "/") => {
  await send("Network.clearBrowserCookies");
  await goto(p);
};
const thirdParty = () => requests.filter((u) => { try { const x = new URL(u); return !["data:", "blob:", "about:"].includes(x.protocol) && x.host !== HOST; } catch { return false; } });
const settle = async () => { await sleep(700); };
// The players are loading="lazy": the browser only requests one when it is near the viewport. Bring it into view, then wait for the request.
const showPlayerAndWait = async () => {
  await until(`document.querySelector('iframe')`);
  await ev(`document.querySelector('iframe').scrollIntoView({ block: 'center' })`);
  const end = Date.now() + 10_000;
  while (!stubbed.some((u) => u.includes("youtube-nocookie.com")) && Date.now() < end) await sleep(200);
};
const showPlaceholderAndWait = async () => {
  await ev(`(document.querySelector('[class*="aspect-video"]') ?? document.body).scrollIntoView({ block: 'center' })`);
  await sleep(1000);
};

let sa: Session;
before(async () => {
  if (!chrome) return;
  // ---- publish a YouTube video section (unless an earlier suite already left one published) ----
  sa = await sessionFor("SUPER_ADMIN");
  const call = (p: string, method: string, body?: unknown) =>
    fetch(`${BASE}${p}`, { method, headers: { origin: BASE, "content-type": "application/json", cookie: `director_session=${sa.cookie}` }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const home = await (await fetch(`${BASE}/`)).text();
  if (!/This video is hosted by (<!-- -->)?YouTube/.test(home)) {
    const s = (await call("/api/admin/website-content", "GET")).json.state;
    const c: EditableContent = JSON.parse(JSON.stringify(s.editing ?? toEditable(DEFAULT_SITE_CONTENT)));
    c.custom = [...(c.custom ?? []), newSection({ type: "video", provider: "youtube", videoId: "dQw4w9WgXcQ" }, "afterSearch")];
    const saved = await call("/api/admin/website-content/draft", "PUT", { content: c, expectedDraftVersion: s.draftVersion });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    const pub = await call("/api/admin/website-content/publish", "POST", { expectedDraftVersion: saved.json.state.draftVersion, expectedPublishedVersion: saved.json.state.publishedVersion, note: "cookie consent test" });
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    const end = Date.now() + 40_000;
    for (;;) {
      if (/This video is hosted by (<!-- -->)?YouTube/.test(await (await fetch(`${BASE}/`)).text())) break;
      assert.ok(Date.now() < end, "the published video never reached the homepage");
      await sleep(500);
    }
  }
  // ---- browser ----
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dl-consent-"));
  proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9351", `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let target: string | undefined;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const tabs = (await (await fetch("http://127.0.0.1:9351/json")).json()) as { type: string; webSocketDebuggerUrl: string }[];
      target = tabs.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch { /* starting */ }
  }
  assert.ok(target, "Chrome did not start");
  ws = new WebSocket(target);
  await new Promise<void>((r) => (ws.onopen = () => r()));
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && pending.has(d.id)) { pending.get(d.id)!(d); pending.delete(d.id); return; }
    if (d.method === "Network.requestWillBeSent") requests.push(d.params.request.url);
    // A cross-origin player frame runs in its own process (its own session): attach to it so its requests are seen and stubbed too.
    if (d.method === "Target.attachedToTarget") {
      const sid = d.params.sessionId as string;
      void (async () => {
        await send("Network.enable", {}, sid).catch(() => undefined);
        await send("Fetch.enable", { patterns: PLAYER_PATTERNS }, sid).catch(() => undefined);
        await send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => undefined);
      })();
    }
    if (d.method === "Fetch.requestPaused") {
      stubbed.push(d.params.request.url);
      void send("Fetch.fulfillRequest", { requestId: d.params.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }], body: Buffer.from("<p>stub player</p>").toString("base64") }, d.sessionId).catch(() => undefined);
    }
    if (d.method === "Runtime.exceptionThrown") problems.push("exception: " + (d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text));
    if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") problems.push("console.error: " + d.params.args.map((a: { value?: string; description?: string }) => a.value ?? a.description).join(" "));
    if (d.method === "Log.entryAdded" && d.params.entry.level === "error" && !/Failed to load resource/.test(d.params.entry.text)) problems.push("log: " + d.params.entry.text);
  };
  for (const m of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await send(m);
  await send("Fetch.enable", { patterns: PLAYER_PATTERNS });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
});
after(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  proc?.kill();
  await db.$disconnect();
});

const T = { skip: chrome ? false : "Chrome is not installed", timeout: 120_000 };

test("fresh visitor: the banner shows, nothing is saved, no third-party request is made, the video is a placeholder", T, async () => {
  requests.length = 0; stubbed.length = 0;
  await freshVisit("/");
  await until(`document.querySelector('section[aria-label="Cookie consent"]')`);
  assert.equal(await consentRecord(), null);
  assert.equal(await iframes(), 0);
  await showPlaceholderAndWait();
  assert.ok(await placeholder(), `the video shows its consent placeholder (diagnostics: ${await ev<string>(`JSON.stringify({ path: location.pathname, htmlHasText: document.documentElement.innerHTML.includes('hosted by'), sections: document.querySelectorAll('section').length, iframes: document.querySelectorAll('iframe').length, textLen: document.body.innerText.length })`)})`);
  await settle();
  assert.deepEqual(thirdParty(), [], `unexpected third-party requests: ${thirdParty().join(", ")}`);
  assert.deepEqual(stubbed, []);
  const buttons = await ev<string>(`[...document.querySelectorAll('section[aria-label="Cookie consent"] button, section[aria-label="Cookie consent"] a')].map(b => b.textContent.trim()).join('|')`);
  for (const t of ["Accept all", "Reject non-essential", "Cookie settings", "Cookie policy"]) assert.ok(buttons.includes(t), `${t} in ${buttons}`);
  const sizes = await ev<number[]>(`['Accept all','Reject non-essential'].map(t => { const b = [...document.querySelectorAll('section button')].find(x => x.textContent.trim() === t); const r = b.getBoundingClientRect(); return Math.round(r.height); })`);
  assert.equal(sizes[0], sizes[1], "Accept all and Reject are the same size");
});

test("closing the settings without saving changes nothing, and leaving and coming back without a choice still shows the banner", T, async () => {
  await freshVisit("/");
  await until(`document.querySelector('section[aria-label="Cookie consent"]')`);
  await clickText("Cookie settings");
  await until(`document.querySelector('[role=dialog]')`);
  assert.equal(await bannerShown(), false, "the banner steps aside while the settings are open");
  assert.equal(await toggleOn(), false);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await until(`!document.querySelector('[role=dialog]')`);
  assert.equal(await consentRecord(), null, "Escape saved nothing");
  assert.equal(await bannerShown(), true, "no choice was made, so the banner is back");
  await clickText("Cookie settings");
  await until(`document.querySelector('[role=dialog]')`);
  await ev(`document.querySelector('button[aria-label="Close cookie settings"]').click()`);
  assert.equal(await consentRecord(), null);
  await goto("/login");
  await goto("/");
  await until(`document.querySelector('section[aria-label="Cookie consent"]')`);
  assert.equal(await consentRecord(), null, "navigating away and back did not create a choice");
});

test("Reject non-essential: saved as 'no videos', banner gone and stays gone after refresh and navigation, optional content stays blocked", T, async () => {
  requests.length = 0; stubbed.length = 0;
  await freshVisit("/");
  await until(`document.querySelector('section[aria-label="Cookie consent"]')`);
  assert.equal(await clickText("Reject non-essential"), true);
  await until(`!document.querySelector('section[aria-label="Cookie consent"]')`);
  const rec = await consentRecord();
  assert.deepEqual([rec.v, rec.media, typeof rec.t], [CONSENT_VERSION, false, "number"]);
  await goto("/");
  assert.equal(await bannerShown(), false, "valid saved choice: no banner after a refresh");
  await goto("/cookie-policy");
  await goto("/");
  assert.equal(await bannerShown(), false, "nor after navigating");
  assert.equal(await iframes(), 0);
  await showPlaceholderAndWait();
  assert.ok(await placeholder());
  await settle();
  assert.deepEqual([...thirdParty(), ...stubbed], [], "videos stayed blocked even with the video area scrolled into view");
});

test("Cookie settings reopens after a saved choice, shows the SAVED choice, and closing it changes nothing", T, async () => {
  const before = (await consentRecord()).raw;
  await clickText("Cookie settings");
  await until(`document.querySelector('[role=dialog]')`);
  assert.equal(await toggleOn(), false, "shows the saved 'rejected' state");
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await until(`!document.querySelector('[role=dialog]')`);
  assert.equal((await consentRecord()).raw, before, "the stored record is byte-for-byte unchanged");
  assert.equal(await bannerShown(), false);
});

test("Save choices stores the selected state exactly; the video then loads; sign-in cookies are untouched", T, async () => {
  const s = await login((await db.user.findUniqueOrThrow({ where: { id: sa.userId } })).email);
  assert.ok(s.cookie);
  await send("Network.setCookie", { name: "director_session", value: s.cookie!, url: BASE, httpOnly: true });
  requests.length = 0; stubbed.length = 0;
  await clickText("Cookie settings");
  await until(`document.querySelector('[role=dialog]')`);
  await ev(`document.querySelector('[role=switch]').click()`);
  assert.equal(await toggleOn(), true);
  assert.equal((await consentRecord()).media, false, "toggling alone saves nothing");
  assert.equal(await clickText("Save choices"), true);
  await until(`!document.querySelector('[role=dialog]')`);
  assert.equal((await consentRecord()).media, true);
  await showPlayerAndWait();
  assert.ok(stubbed.some((u) => u.includes("youtube-nocookie.com/embed/dQw4w9WgXcQ")), `the player was requested only after consent: stubbed=[${stubbed.join(", ")}] seen=[${requests.filter((u) => /youtube|vimeo/.test(u)).join(", ")}] iframe=${await ev<string>(`JSON.stringify([...document.querySelectorAll('iframe')].map(f => ({ src: f.getAttribute('src'), sandbox: f.getAttribute('sandbox') })))`)}`);
  assert.ok((await cookieNames()).includes("director_session"), "the session cookie survived the consent change");
  await goto("/");
  assert.equal(await bannerShown(), false);
  await until(`document.querySelector('iframe')`);
  await goto("/dashboard");
  assert.equal(await ev<string>(`location.pathname`), "/dashboard", "the signed-in session still works");
});

test("withdrawing consent shows the saved choice as ON, then removes the player at once; the session survives", T, async () => {
  await goto("/");
  await until(`document.querySelector('iframe')`);
  await clickText("Cookie settings");
  await until(`document.querySelector('[role=dialog]')`);
  assert.equal(await toggleOn(), true, "the footer link opens with the CURRENT saved choice (this was the reported inconsistency)");
  await ev(`document.querySelector('[role=switch]').click()`);
  await clickText("Save choices");
  await until(`!document.querySelector('[role=dialog]')`);
  assert.equal((await consentRecord()).media, false);
  await until(`document.querySelectorAll('iframe').length === 0`, 5000);
  assert.ok(await placeholder(), "the player is gone without a reload");
  assert.ok((await cookieNames()).includes("director_session"));
});

test("Accept all saves 'videos allowed' and the video loads; the banner does not return", T, async () => {
  requests.length = 0; stubbed.length = 0;
  await freshVisit("/");
  await until(`document.querySelector('section[aria-label="Cookie consent"]')`);
  await clickText("Accept all");
  assert.equal((await consentRecord()).media, true);
  await showPlayerAndWait();
  assert.ok(stubbed.length >= 1, "after Accept all the player is requested");
  await goto("/");
  assert.equal(await bannerShown(), false);
});

test("malformed, outdated, expired and future-dated records are ignored: the banner is shown again", T, async () => {
  const good = { v: CONSENT_VERSION, media: true, t: Date.now() };
  const cases: [string, string][] = [
    ["garbage", "%%%not-json"],
    ["older version", encodeURIComponent(JSON.stringify({ ...good, v: CONSENT_VERSION - 1 }))],
    ["no timestamp", encodeURIComponent(JSON.stringify({ v: CONSENT_VERSION, media: true }))],
    ["expired", encodeURIComponent(JSON.stringify({ ...good, t: Date.now() - 181 * DAY }))],
    ["future", encodeURIComponent(JSON.stringify({ ...good, t: Date.now() + 2 * DAY }))],
  ];
  for (const [label, value] of cases) {
    await send("Network.clearBrowserCookies");
    await setConsentCookie(value);
    await goto("/");
    await until(`document.querySelector('section[aria-label="Cookie consent"]')`, 8000).catch(() => assert.fail(`${label}: banner not shown`));
    assert.equal(await iframes(), 0, `${label}: the video must stay blocked`);
  }
  await send("Network.clearBrowserCookies");
  await setConsentCookie(encodeURIComponent(JSON.stringify({ ...good, t: Date.now() - 100 * DAY })));
  await goto("/");
  assert.equal(await bannerShown(), false, "a valid 100-day-old record is still honoured");
});

test("if the browser refuses the cookie, the choice is not reported as saved", T, async () => {
  await freshVisit("/");
  await until(`document.querySelector('section[aria-label="Cookie consent"]')`);
  await ev(`(Object.defineProperty(document, 'cookie', { get: () => '', set: () => {}, configurable: true }), true)`);
  await clickText("Accept all");
  await until(`document.querySelector('section[aria-label="Cookie consent"] [role=alert]')`);
  assert.equal(await bannerShown(), true, "the banner stays");
  assert.equal(await consentRecord(), null);
  assert.equal(await iframes(), 0);
});

test("production builds ignore the development-only reset link", T, async () => {
  await freshVisit("/");
  await until(`document.querySelector('section[aria-label="Cookie consent"]')`);
  await clickText("Reject non-essential");
  await until(`!document.querySelector('section[aria-label="Cookie consent"]')`);
  const before = (await consentRecord()).raw;
  await goto("/?reset-consent=1");
  assert.equal((await consentRecord()).raw, before);
  assert.equal(await bannerShown(), false);
});

test("keyboard and focus: the dialog traps Tab, locks background scrolling, closes on Escape and returns focus to the footer link", T, async () => {
  await goto("/");
  await ev(`[...document.querySelectorAll('footer button')].find(b => b.textContent.trim() === 'Cookie settings').focus()`);
  await clickText("Cookie settings");
  await until(`document.querySelector('[role=dialog]')`);
  assert.equal(await ev<boolean>(`document.querySelector('[role=dialog]').contains(document.activeElement)`), true, "focus moved into the dialog");
  assert.equal(await ev<string>(`document.body.style.overflow`), "hidden");
  for (let i = 0; i < 14; i++) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    assert.equal(await ev<boolean>(`document.querySelector('[role=dialog]').contains(document.activeElement)`), true, `focus escaped the dialog on Tab ${i + 1}`);
  }
  const names = await ev<string>(`document.querySelector('[role=dialog]').getAttribute('aria-labelledby') + '|' + document.querySelector('[role=switch]').getAttribute('aria-labelledby')`);
  assert.equal(names, "cookie-settings-title|media-label");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(`!document.querySelector('[role=dialog]')`);
  assert.notEqual(await ev<string>(`document.body.style.overflow`), "hidden", "scrolling is restored");
  assert.equal(await ev<boolean>(`document.activeElement.textContent.trim() === 'Cookie settings'`), true, "focus returned to the opener");
});

test("policy pages and every public footer link work without signing in, and the footer links to them", T, async () => {
  const hrefs = new Set<string>();
  for (const p of ["/", "/cookie-policy", "/privacy-policy"]) {
    const res = await fetch(`${BASE}${p}`, { redirect: "manual" });
    assert.equal(res.status, 200, p);
    const html = await res.text();
    for (const m of html.matchAll(/<a [^>]*href="(\/[^"#]*)"/g)) hrefs.add(m[1]);
    if (p !== "/") assert.ok(!/Draft for review/.test(html) && !/<br/i.test(html), "no draft box and no <br> markers in the policy pages");
    if (p === "/") assert.ok(/href="\/cookie-policy"/.test(html) && /href="\/privacy-policy"/.test(html), "home footer links to both policies");
  }
  assert.ok(hrefs.has("/cookie-policy") && hrefs.has("/privacy-policy"));
  for (const h of hrefs) {
    if (h.startsWith("/media/") || h.startsWith("/_next")) continue;
    const r = await fetch(`${BASE}${h}`, { redirect: "manual" });
    assert.ok([200, 307, 308].includes(r.status), `${h} -> ${r.status}`);
  }
  const cookie = await (await fetch(`${BASE}/cookie-policy`)).text();
  for (const k of ["director_session", "dl_cal_oauth", "director_consent", "pendingReportFilter", "cms-colour-memory-v1", "youtube-nocookie.com", "player.vimeo.com"]) assert.ok(cookie.includes(k), `cookie policy mentions ${k}`);
  const privacy = await (await fetch(`${BASE}/privacy-policy`)).text();
  assert.match(privacy, /Not yet provided/);
});

test("mobile (390px): banner and settings fit, every action button is on screen, no horizontal scroll", T, async () => {
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
  await freshVisit("/");
  await until(`document.querySelector('section[aria-label="Cookie consent"]')`);
  const fits = `document.documentElement.scrollWidth <= document.documentElement.clientWidth`;
  assert.equal(await ev<boolean>(fits), true, "banner: no horizontal scroll");
  const bannerButtons = await ev<boolean>(`[...document.querySelectorAll('section[aria-label="Cookie consent"] button')].every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })`);
  assert.equal(bannerButtons, true, "all three banner buttons are fully on screen");
  await clickText("Cookie settings");
  await until(`document.querySelector('[role=dialog]')`);
  assert.equal(await ev<boolean>(fits), true, "dialog: no horizontal scroll");
  const dlg = await ev<boolean>(`(() => { const d = document.querySelector('[role=dialog]'); const r = d.getBoundingClientRect(); const btns = [...d.querySelectorAll('button')].filter(b => ['Reject non-essential','Accept all','Save choices'].includes(b.textContent.trim())); d.scrollTop = d.scrollHeight; return r.left >= 0 && r.right <= innerWidth && btns.length === 3 && btns.every(b => { const q = b.getBoundingClientRect(); return q.left >= 0 && q.right <= innerWidth && q.bottom <= innerHeight + 1; }); })()`);
  assert.equal(dlg, true, "the dialog's three buttons are reachable on a short phone screen");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
});

// ---- design requirements, measured in the real browser --------------------------------------------------------------------------
const parseRgb = (c: string) => { const m = /rgba?\(([^)]+)\)/.exec(c)!; const [r, g, b, a] = m[1].split(",").map((x) => Number(x.trim())); return { r, g, b, a: a ?? 1 }; };
const lum = ({ r, g, b }: { r: number; g: number; b: number }) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const NORM = `const n = (v) => { const x = document.createElement('canvas').getContext('2d'); x.clearRect(0, 0, 1, 1); x.fillStyle = v; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return 'rgba(' + d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + (Math.round(d[3] / 255 * 100) / 100) + ')'; };`;
const styleOf = (sel: string, text?: string) => ev<Record<string, string>>(`(() => { ${NORM} const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const e = ${text ? `els.find(x => x.textContent.trim() === ${JSON.stringify(text)})` : "els[0]"}; const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return { bg: n(c.backgroundColor), color: n(c.color), h: String(Math.round(r.height)), w: String(Math.round(r.width)), top: String(Math.round(r.top)), bottom: String(Math.round(r.bottom)), backdrop: c.backdropFilter || c.webkitBackdropFilter || '', deco: c.textDecorationLine, radius: c.borderTopLeftRadius, weight: c.fontWeight, size: c.fontSize, minH: c.minHeight }; })()`);
const BANNER = `section[aria-label="Cookie consent"]`;

test("banner design: slim, translucent over the page, readable; Reject red and Accept green, both white text, same size", T, async () => {
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await freshVisit("/");
  await until(`document.querySelector('${BANNER}')`);
  const banner = await styleOf(BANNER);
  assert.ok(Number(banner.h) <= 100, `desktop banner height ${banner.h}px (it was about 175px) must be slim`);
  const bg = parseRgb(banner.bg);
  assert.ok(bg.a > 0.5 && bg.a < 0.95, `translucent navy: alpha ${bg.a}`);
  assert.match(banner.backdrop, /blur/, "backdrop blur is applied where supported");
  // text stays opaque and readable in the WORST case: the translucent navy over a plain white page
  const over = { r: bg.r * bg.a + 255 * (1 - bg.a), g: bg.g * bg.a + 255 * (1 - bg.a), b: bg.b * bg.a + 255 * (1 - bg.a) };
  const text = await ev<string>(`(() => { ${NORM} return n(getComputedStyle(document.querySelector('${BANNER} p')).color); })()`);
  assert.equal(parseRgb(text).a, 1, "text is not transparent");
  assert.ok(contrast(parseRgb(text), over) >= 7, `banner text contrast ${contrast(parseRgb(text), over).toFixed(1)}`);
  const reject = await styleOf(`${BANNER} button`, "Reject non-essential");
  const accept = await styleOf(`${BANNER} button`, "Accept all");
  const red = parseRgb(reject.bg);
  const green = parseRgb(accept.bg);
  assert.ok(red.r >= 180 && red.g <= 90 && red.b <= 90 && red.a === 1, `Reject is red: ${reject.bg}`);
  assert.ok(green.g >= 100 && green.g > green.r + 60 && green.g > green.b + 40 && green.a === 1, `Accept is green: ${accept.bg}`);
  for (const b of [reject, accept]) {
    assert.equal(b.color, "rgba(255, 255, 255, 1)", "white text");
    assert.ok(contrast(parseRgb(b.color), parseRgb(b.bg)) >= 4.5, `button contrast ${contrast(parseRgb(b.color), parseRgb(b.bg)).toFixed(2)}`);
  }
  for (const k of ["h", "radius", "weight", "size"] as const) assert.equal(reject[k], accept[k], `Reject and Accept share ${k}`);
  const settings = await styleOf(`${BANNER} button`, "Cookie settings");
  assert.equal(settings.deco, "underline", "Cookie settings is a distinct text-style action");
  assert.equal(parseRgb(settings.bg).a, 0, "no filled background: a text-style action");
  assert.ok(Number(settings.h) >= 36);
  const shot = await send("Page.captureScreenshot", {});
  fs.writeFileSync(path.join(os.tmpdir(), "dl-banner-desktop.png"), Buffer.from(shot.data, "base64"));
});

test("banner behaviour: keyboard focus ring, bottom spacing while shown and removed after a choice, hover and active states", T, async () => {
  await freshVisit("/");
  await until(`document.querySelector('${BANNER}')`);
  const h = Number((await styleOf(BANNER)).h);
  const pad = await ev<number>(`parseInt(document.body.style.paddingBottom || '0', 10)`);
  assert.ok(pad >= h, `bottom padding ${pad}px keeps the footer clear of the ${h}px banner`);
  // reach "Reject non-essential" with the Tab key and read the focus indicator the browser really draws
  let focused = "";
  for (let i = 0; i < 150 && focused !== "Reject non-essential"; i++) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    focused = await ev<string>(`document.activeElement?.textContent?.trim() ?? ''`);
  }
  assert.equal(focused, "Reject non-essential", "the buttons are reachable with Tab");
  const ring = await ev<Record<string, string>>(`(() => { ${NORM} const c = getComputedStyle(document.activeElement); return { style: c.outlineStyle, width: c.outlineWidth, color: n(c.outlineColor) }; })()`);
  assert.ok(ring.style !== "none" && ring.width !== "0px", `visible focus ring: ${JSON.stringify(ring)}`);
  assert.equal(parseRgb(ring.color).a, 1);
  const css = await ev<string>(`[...document.styleSheets].flatMap(s => { try { return [...s.cssRules].map(r => r.cssText) } catch { return [] } }).join(' ')`);
  assert.ok(css.includes("hover\\:bg-red-700") && css.includes("hover\\:bg-green-800") && css.includes("active\\:brightness-90") && css.includes("disabled\\:opacity-60"), "hover, active and disabled states exist in the shipped CSS");
  await clickText("Reject non-essential");
  await until(`!document.querySelector('${BANNER}')`);
  assert.equal(await ev<string>(`document.body.style.paddingBottom`), "", "the spacing is given back once the banner is gone");
});

test("banner fits short screens, narrow phones and 200% zoom, with no clipped text and no overlap of the page heading or footer", T, async () => {
  const cases: [string, number, number, boolean][] = [["phone 390x600", 390, 600, true], ["phone 360x560", 360, 560, true], ["200% zoom of a 1280x720 screen", 640, 360, false], ["short laptop 1280x600", 1280, 600, false]];
  for (const [label, w, h, mobile] of cases) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await freshVisit("/cookie-policy");
    await until(`document.querySelector('${BANNER}')`);
    const r = await ev<Record<string, number | boolean>>(`(() => { const b = document.querySelector('${BANNER}'); const q = b.getBoundingClientRect(); const btns = [...b.querySelectorAll('button')].map(x => x.getBoundingClientRect()); const h1 = document.querySelector('h1').getBoundingClientRect(); return { top: q.top, bottom: q.bottom, left: q.left, right: q.right, vw: innerWidth, vh: innerHeight, clipped: b.scrollWidth > b.clientWidth + 1, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, tapOk: btns.every(x => x.height >= 36 && x.left >= 0 && x.right <= innerWidth), h1Clear: h1.bottom <= q.top || h1.top >= q.bottom }; })()`);
    assert.ok((r.top as number) >= 0 && (r.bottom as number) <= (r.vh as number) && (r.left as number) >= 0 && (r.right as number) <= (r.vw as number), `${label}: banner within the viewport ${JSON.stringify(r)}`);
    assert.equal(r.clipped, false, `${label}: no clipped text`);
    assert.equal(r.hscroll, false, `${label}: no horizontal scroll`);
    assert.equal(r.tapOk, true, `${label}: tap targets are at least 36px and on screen`);
    // the footer controls can be scrolled clear of the banner
    await ev(`window.scrollTo(0, document.documentElement.scrollHeight)`);
    await sleep(300);
    const clear = await ev<boolean>(`(() => { const b = document.querySelector('${BANNER}').getBoundingClientRect(); const f = [...document.querySelectorAll('footer a, footer button')].map(x => x.getBoundingClientRect()); return f.every(x => x.bottom <= b.top + 1 || x.top >= b.bottom - 1); })()`);
    assert.equal(clear, true, `${label}: footer links are not covered by the banner once scrolled to the end`);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
});

test("policy pages render cleanly: no draft box, no raw markup, separate nav items, a readable table or cards, working jump links", T, async () => {
  await send("Network.clearBrowserCookies");
  for (const [p, h1] of [["/cookie-policy", "Cookie policy"], ["/privacy-policy", "Privacy policy"]] as const) {
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await goto(p);
    const d = await ev<Record<string, unknown>>(`(() => { const t = document.body.innerText; return { h1: document.querySelector('h1').textContent, draft: /draft for review/i.test(t), rawBr: /<br\\s*\\/?>/i.test(t) || /<\\w+[^>]*>/.test(t), navItems: document.querySelectorAll('nav[aria-label="Site"] li').length, footerItems: document.querySelectorAll('footer li').length, amber: !!document.querySelector('[class*="amber"]'), updated: /Last updated: 26 October 2026/.test(t), hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, width: Math.round(document.querySelector('main').getBoundingClientRect().width) }; })()`);
    assert.equal(d.h1, h1);
    assert.equal(d.draft, false, `${p}: no draft notice`);
    assert.equal(d.amber, false, `${p}: no warning-box styling`);
    assert.equal(d.rawBr, false, `${p}: no raw markup shown as text`);
    assert.equal(d.navItems, 2);
    assert.equal(d.footerItems, 3);
    assert.equal(d.updated, true);
    assert.equal(d.hscroll, false);
    assert.ok((d.width as number) <= 1024, "content is not stretched edge to edge");
  }
  await goto("/cookie-policy");
  const desktop = await ev<Record<string, unknown>>(`(() => { const t = document.querySelector('table'); const cards = document.querySelector('ul[aria-label^="Cookies and similar"]'); const heads = [...t.querySelectorAll('thead th')].map(x => x.textContent.trim()); const rows = t.querySelectorAll('tbody tr').length; const w = t.getBoundingClientRect().width; return { tableShown: getComputedStyle(t.parentElement).display !== 'none', cardsHidden: getComputedStyle(cards).display === 'none', heads: heads.join('|'), rows, tableFits: w <= t.parentElement.getBoundingClientRect().width + 1, brCount: document.querySelectorAll('table br').length }; })()`);
  assert.equal(desktop.tableShown, true);
  assert.equal(desktop.cardsHidden, true);
  assert.equal(desktop.heads, "Name|Type and provider|What it is for|How long|Category");
  assert.equal(desktop.rows, 5);
  assert.equal(desktop.tableFits, true);
  assert.equal(desktop.brCount, 0);
  for (const id of ["what-we-use", "embedded-videos", "change-your-choice"]) {
    await ev(`document.querySelector('a[href="#${id}"]').click()`);
    await sleep(250);
    assert.ok(await ev<boolean>(`document.getElementById(${JSON.stringify(id)}).getBoundingClientRect().top < innerHeight`), `jump link ${id}`);
  }
  // phones: the table is replaced by one card per cookie, and nothing scrolls sideways
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await goto("/cookie-policy");
  const phone = await ev<Record<string, unknown>>(`(() => { const t = document.querySelector('table'); const cards = document.querySelectorAll('ul[aria-label^="Cookies and similar"] > li'); return { tableHidden: getComputedStyle(t.parentElement).display === 'none', cards: cards.length, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, firstCard: cards[0].innerText.replace(/\\s+/g, ' ').slice(0, 120) }; })()`);
  assert.equal(phone.tableHidden, true);
  assert.equal(phone.cards, 5);
  assert.equal(phone.hscroll, false);
  assert.match(String(phone.firstCard), /director_session/);
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
});

test("audit in the browser: anonymous pages set no cookie except the consent choice and store nothing in local or session storage", T, async () => {
  await send("Network.clearBrowserCookies");
  for (const p of ["/", "/login", "/register", "/forgot-password", "/cookie-policy", "/privacy-policy"]) {
    await goto(p);
    const stored = await ev<string>(`JSON.stringify({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie })`);
    assert.deepEqual(JSON.parse(stored), { local: [], session: [], cookie: "" }, `${p} before any choice`);
  }
  await goto("/");
  await until(`document.querySelector('${BANNER}')`);
  await clickText("Reject non-essential");
  await until(`!document.querySelector('${BANNER}')`);
  assert.deepEqual(await cookieNames(), [CONSENT_COOKIE], "only the consent cookie exists after a choice");
  const after = await ev<string>(`JSON.stringify({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })`);
  assert.deepEqual(JSON.parse(after), { local: [], session: [] });
});

test("across the whole run: no console errors, exceptions or hydration errors, and no request ever left the site except the stubbed player", T, async () => {
  assert.deepEqual(problems, []);
  const all = [...new Set(thirdParty())];
  assert.ok(all.every((u) => /youtube-nocookie\.com|player\.vimeo\.com|challenges\.cloudflare\.com/.test(u)), `unexpected hosts: ${all.join(", ")}`);
});
