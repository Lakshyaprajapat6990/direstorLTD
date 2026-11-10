import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CONSENT_COOKIE, CONSENT_MAX_AGE_SECONDS, CONSENT_VERSION, clearConsentCookieString, consentCookieString, parseConsent, readConsentFromCookieString, serialiseConsent, shouldResetConsent } from "../../src/lib/consent";

const root = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const rec = (o: unknown) => encodeURIComponent(JSON.stringify(o));

// ---- the stored record -----------------------------------------------------------------------------------------------------------
test("a valid record round-trips with the choice and the time it was made", () => {
  for (const media of [true, false]) assert.deepEqual(parseConsent(serialiseConsent(media, NOW), NOW), { v: CONSENT_VERSION, media, t: NOW });
  assert.deepEqual(Object.keys(JSON.parse(decodeURIComponent(serialiseConsent(true, NOW)))).sort(), ["media", "t", "v"], "only the necessary preference information is stored");
});

test("malformed, outdated, expired and future-dated records all count as 'no choice' (the banner is shown again)", () => {
  const bad: [string, unknown][] = [
    ["empty", ""],
    ["null", null],
    ["not json", "not-json"],
    ["broken escape", "%E0%A4%A"],
    ["array", rec([1])],
    ["version 1 (before the policy pages and timestamp)", rec({ v: 1, media: true, t: NOW })],
    ["a newer version", rec({ v: CONSENT_VERSION + 1, media: true, t: NOW })],
    ["no timestamp", rec({ v: CONSENT_VERSION, media: true })],
    ["media is not a boolean", rec({ v: CONSENT_VERSION, media: "yes", t: NOW })],
    ["timestamp is not a number", rec({ v: CONSENT_VERSION, media: true, t: "now" })],
    ["expired (181 days old)", rec({ v: CONSENT_VERSION, media: true, t: NOW - 181 * DAY })],
    ["dated in the future", rec({ v: CONSENT_VERSION, media: true, t: NOW + DAY })],
  ];
  for (const [label, raw] of bad) assert.equal(parseConsent(typeof raw === "string" ? raw : null, NOW), null, label);
  assert.ok(parseConsent(rec({ v: CONSENT_VERSION, media: false, t: NOW - 179 * DAY }), NOW), "179 days old is still valid");
  assert.ok(parseConsent(rec({ v: CONSENT_VERSION, media: true, t: NOW + 60_000 }), NOW), "a minute of clock skew is tolerated");
});

test("the cookie is first-party, SameSite=Lax, 180 days, Secure on https; clearing removes only the consent cookie", () => {
  const set = consentCookieString(false, true, NOW);
  assert.match(set, new RegExp(`^${CONSENT_COOKIE}=`));
  for (const part of [`Max-Age=${CONSENT_MAX_AGE_SECONDS}`, "Path=/", "SameSite=Lax", "Secure"]) assert.ok(set.includes(part), part);
  assert.ok(!consentCookieString(true, false, NOW).includes("Secure"));
  assert.ok(!/HttpOnly/i.test(set), "the page must be able to read it");
  assert.equal(CONSENT_MAX_AGE_SECONDS, 180 * 86400);
  const clear = clearConsentCookieString(true);
  assert.ok(clear.startsWith(`${CONSENT_COOKIE}=;`) && clear.includes("Max-Age=0") && clear.includes("Path=/"));
  assert.ok(!/director_session/.test(clear + set), "never touches the session cookie");
  const jar = `a=1; ${CONSENT_COOKIE}=${serialiseConsent(true, NOW)}; director_session=xyz`;
  assert.equal(readConsentFromCookieString(jar, NOW)?.media, true);
  assert.equal(readConsentFromCookieString("a=1; b=2", NOW), null);
});

test("the fresh-visit reset exists in development only and only for the exact parameter", () => {
  assert.equal(shouldResetConsent("?reset-consent=1", "development"), true);
  assert.equal(shouldResetConsent("?x=1&reset-consent=1", undefined), true);
  assert.equal(shouldResetConsent("?reset-consent=1", "production"), false, "never in a production build");
  for (const q of ["", "?reset-consent=0", "?reset-consent=true", "?reset=1", "?reset-consent="]) assert.equal(shouldResetConsent(q, "development"), false, q);
});

// ---- behaviour of the banner and settings (checked in the source; the clicks themselves are in the real-browser test) -----------
test("the banner shows only without a valid saved choice, and closing the settings never saves anything", () => {
  const ui = read("src/components/consent/CookieConsent.tsx");
  assert.match(ui, /const showBanner = known && !consent && !settingsOpen;/);
  const close = /function closeSettings\(\) \{([\s\S]*?)\n  \}/.exec(ui);
  assert.ok(close, "closeSettings exists");
  assert.ok(!/writeConsent|choose\(/.test(close![1]), "closing is not a choice");
  // opening from the banner AND from the footer link loads the CURRENT saved choice
  assert.match(ui, /const openSettings = useCallback\(\(\) => \{\s*setMedia\(readConsent\(getConsentSnapshot\(\)\)\?\.media \?\? false\);/);
  assert.match(ui, /addEventListener\(OPEN_SETTINGS_EVENT, openSettings\)/);
  // a choice is only reported as saved once the browser confirmed it
  assert.match(ui, /if \(!writeConsent\(allowMedia\)\) \{\s*setError\(BLOCKED\);\s*return;\s*\}/);
  const store = read("src/components/consent/store.ts");
  assert.match(store, /const saved = parseConsent\(getConsentSnapshot\(\)\);\s*if \(!saved \|\| saved\.media !== media\) return false;/);
});

test("Accept all and Reject non-essential are equally prominent; Save choices saves the selected state; accessibility hooks exist", () => {
  const ui = read("src/components/consent/CookieConsent.tsx");
  // Reject is red and Accept is green with white text, built from the SAME base (same size, weight, shape, focus and active states).
  assert.match(ui, /const rejectButton = `\$\{choiceButton\} bg-red-600 hover:bg-red-700`;/);
  assert.match(ui, /const acceptButton = `\$\{choiceButton\} bg-green-700 hover:bg-green-800`;/);
  assert.match(ui, /const choiceButton = "[^"]*text-white[^"]*focus-visible:outline-2[^"]*active:brightness-90[^"]*disabled:opacity-60/);
  assert.match(ui, /onClick=\{\(\) => choose\(false\)\} className=\{`[^`]*\$\{rejectButton\}`\}/);
  assert.match(ui, /onClick=\{\(\) => choose\(true\)\} className=\{`[^`]*\$\{acceptButton\}`\}/);
  // translucent navy with a blur where the browser supports it, and a near-opaque fallback where it does not
  assert.match(ui, /bg-indigo-950\/95[^"]*supports-\[backdrop-filter\]:bg-indigo-950\/85[^"]*supports-\[backdrop-filter\]:backdrop-blur-md/);
  // the page keeps matching bottom padding while the banner is showing, and gives it back afterwards
  assert.match(ui, /document\.body\.style\.paddingBottom = `\$\{Math\.ceil\(el\.getBoundingClientRect\(\)\.height\) \+ 20\}px`/);
  assert.match(ui, /document\.body\.style\.paddingBottom = "";/);
  assert.match(ui, /onSave=\{\(\) => choose\(media\)\}/, "Save choices stores exactly the toggle's state");
  assert.match(ui, /onAccept=\{\(\) => choose\(true\)\}/);
  assert.match(ui, /onReject=\{\(\) => choose\(false\)\}/);
  for (const a of ['role="dialog" aria-modal="true"', "aria-labelledby=\"cookie-settings-title\"", 'aria-label="Cookie consent"', 'role="switch"', 'role="alert"', 'e.key === "Escape"', 'document.body.style.overflow = "hidden"', "previous?.focus"]) assert.ok(ui.includes(a), a);
  assert.match(ui, /href="\/cookie-policy"/);
  assert.match(ui, /href="\/privacy-policy"/);
  assert.ok(!/localStorage|sessionStorage/.test(ui), "consent uses one cookie only");
});

// ---- the inventory is complete, and the policy pages state exactly what the code does -------------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test("every cookie and browser-storage key the application writes is listed in the cookie policy (a new one fails this test)", () => {
  const files = walk("src");
  const policy = read("src/app/cookie-policy/page.tsx");
  // cookies set on the server
  const setters = files.flatMap((f) => (read(f).match(/(?:res\.cookies|store|cookieStore|\(await cookies\(\)\))\.set\(/g) ?? []).map(() => f));
  assert.deepEqual([...new Set(setters)].sort(), ["src/app/api/calendar/connect/google/route.ts", "src/lib/auth/session.ts"], "a new server-set cookie must be added to the cookie policy and this list");
  assert.equal(setters.length, 2);
  assert.match(policy, /SESSION_COOKIE_NAME/);
  assert.match(policy, /OAUTH_STATE_COOKIE/);
  assert.match(policy, /CONSENT_COOKIE/);
  // browser storage keys
  const sessionKeys = new Set<string>();
  const localKeys = new Set<string>();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/sessionStorage\.setItem\("([^"]+)"/g)) sessionKeys.add(m[1]);
    for (const m of src.matchAll(/localStorage\.setItem\(([A-Za-z_"][^,]*),/g)) {
      const k = m[1].replace(/"/g, "");
      const lit = /^[A-Z_]+$/.test(k) ? new RegExp(`const ${k} = "([^"]+)"`).exec(src)?.[1] : k;
      if (lit) localKeys.add(lit);
    }
    assert.ok(!/document\.cookie\s*=/.test(src) || f.startsWith("src/components/consent/"), `${f} writes document.cookie`);
    assert.ok(!/indexedDB|serviceWorker|caches\.open/.test(src), `${f} uses another storage technology`);
  }
  assert.deepEqual([...sessionKeys].sort(), ["pendingReportColumns", "pendingReportFilter", "pendingReportQuery", "pendingReportSort"]);
  assert.deepEqual([...localKeys], ["cms-colour-memory-v1"]);
  for (const k of [...sessionKeys, ...localKeys]) assert.ok(policy.includes(k), `cookie policy must list ${k}`);
});

test("no analytics, advertising, pixel, tag-manager or social-widget code or script tag exists anywhere in the source", () => {
  const offenders: string[] = [];
  for (const f of walk("src")) {
    const src = read(f);
    if (/(googletagmanager|google-analytics|gtag\(|fbq\(|hotjar|plausible\.io|segment\.com|mixpanel|clarity\.ms|doubleclick|addthis|sharethis|facebook\.net|connect\.facebook|platform\.twitter|linkedin\.com\/insight)/i.test(src)) offenders.push(f);
    if (/<Script\b|from "next\/script"|dangerouslySetInnerHTML/.test(src)) offenders.push(`${f} (script tag)`);
  }
  assert.deepEqual(offenders, []);
  const cfg = read("next.config.ts");
  for (const directive of ["script-src 'self'", "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com"]) assert.ok(cfg.includes(directive), directive);
});

test("the policy pages exist, are public, link to each other, and invent no business details", () => {
  for (const [file, h] of [["src/app/cookie-policy/page.tsx", "Cookie policy"], ["src/app/privacy-policy/page.tsx", "Privacy policy"]] as const) {
    const src = read(file);
    assert.match(src, new RegExp(`title="${h}"`));
    assert.ok(!/requireSession|getSession|requirePermission/.test(src), `${file} must not need authentication`);
    // no postcode, phone number, email address, VAT or company-number-looking invented details
    assert.ok(!/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b/.test(src), `${file}: a postcode`);
    assert.ok(!/\+?\d[\d\s()-]{9,}\d/.test(src.replace(/\d{1,3}(,\d{3})+/g, "")), `${file}: a phone number`);
    assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(src), `${file}: an email address`);
    assert.ok(!/VAT|registered office|company number \d/i.test(src), `${file}: invented business details`);
  }
  const legal = read("src/components/legal/LegalPage.tsx");
  // The prominent "Draft for review" box is gone from every policy page. No false assurance replaces it (nothing says reviewed or compliant),
  // and the real disclosures stay: what has not been provided is still listed on the privacy page and the cookie page's contact section.
  assert.ok(!/Draft for review|bg-amber|border-amber/.test(legal));
  for (const f of ["src/app/cookie-policy/page.tsx", "src/app/privacy-policy/page.tsx"]) assert.ok(!/Draft for review/.test(read(f)), f);
  for (const f of ["src/app/cookie-policy/page.tsx", "src/app/privacy-policy/page.tsx", "src/components/legal/LegalPage.tsx"]) assert.ok(!/legally compliant|fully compliant|approved by a lawyer|reviewed by a lawyer|GDPR[- ]compliant/i.test(read(f)), `${f}: no assurance of compliance or review`);
  assert.match(legal, /<CookieConsent \/>/);
  assert.match(read("src/app/privacy-policy/page.tsx"), /Not yet provided/);
  assert.match(read("src/app/cookie-policy/page.tsx"), /Contact details for the organisation that runs this site have not been added/);
  // layout: real list navigation, a table that becomes cards on phones, and no <br> elements in the cookie table
  assert.match(legal, /<nav aria-label="Site">\s*<ul/);
  const cookiePage = read("src/app/cookie-policy/page.tsx");
  assert.ok(!/<br/.test(cookiePage), "no <br> markers in the cookie table");
  assert.match(cookiePage, /hidden overflow-hidden rounded-xl border border-slate-200 md:block/);
  assert.match(cookiePage, /className="space-y-3 md:hidden"/);
  for (const id of ["what-we-use", "embedded-videos", "change-your-choice"]) assert.ok(cookiePage.includes(`href="#${id}"`) && cookiePage.includes(`id="${id}"`), id);
  assert.match(read("src/components/marketing/Footer.tsx"), /href="\/cookie-policy"[\s\S]*href="\/privacy-policy"[\s\S]*<CookieSettingsLink/);
  assert.match(read("src/app/register/RegisterForm.tsx"), /href="\/privacy-policy"/);
});

test("the sign-in, register and password-recovery pages (one shared shell) link to the cookie policy, since signing in sets the session cookie", () => {
  const shell = read("src/components/auth/AuthShell.tsx");
  assert.match(shell, /<Link href="\/cookie-policy"/);
  for (const page of ["login", "register", "forgot-password", "reset-password"]) assert.match(read(`src/app/${page}/page.tsx`), /<AuthShell/, `${page} uses the shared shell`);
  // a link only: no banner is mounted on these pages because nothing optional is used there
  assert.ok(!/CookieConsent/.test(shell));
});

test("the signed-in app shell links to the cookie policy, and the Super Admin preview's Cookie settings only explains (never touches the real consent)", () => {
  assert.match(read("src/components/app-shell/AppShell.tsx"), /<footer[\s\S]*<Link href="\/cookie-policy"[\s\S]*<\/footer>/);
  const notice = read("src/components/consent/PreviewCookieNotice.tsx");
  assert.match(notice, /OPEN_SETTINGS_EVENT/);
  // it must not read, write or clear any cookie or browser storage, and must not import the consent store
  assert.ok(!/document\.cookie|localStorage|sessionStorage|writeConsent|clearConsent|from "\.\/store"|parseConsent/.test(notice), "the preview notice must not touch consent or storage");
  const preview = read("src/app/website-preview/page.tsx");
  assert.match(preview, /<PreviewCookieNotice \/>/);
  assert.ok(!/<CookieConsent/.test(preview), "the public banner stays out of the preview");
});
