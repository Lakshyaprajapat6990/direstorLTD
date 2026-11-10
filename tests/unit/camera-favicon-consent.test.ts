import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CAMERA_MESSAGES, cameraSupport, classifyCameraError } from "../../src/lib/camera";

const root = path.join(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
const bin = (p: string) => fs.readFileSync(path.join(root, p));

// ---- camera -------------------------------------------------------------------------------------------------------------------
test("camera errors map to the right problem and every message points to the gallery fallback", () => {
  const named = (name: string) => Object.assign(new Error("x"), { name });
  assert.equal(classifyCameraError(named("NotAllowedError")), "denied");
  assert.equal(classifyCameraError(named("SecurityError")), "denied");
  assert.equal(classifyCameraError(named("NotFoundError")), "none");
  assert.equal(classifyCameraError(named("OverconstrainedError")), "none");
  assert.equal(classifyCameraError(named("NotReadableError")), "busy");
  assert.equal(classifyCameraError(named("Whatever")), "other");
  assert.equal(classifyCameraError(null), "other");
  assert.equal(classifyCameraError("boom"), "other");
  for (const m of Object.values(CAMERA_MESSAGES)) assert.match(m, /gallery/);
});

test("camera support is judged before the camera is touched", () => {
  assert.equal(cameraSupport({ isSecureContext: false, hasMediaDevices: true }), "insecure");
  assert.equal(cameraSupport({ isSecureContext: true, hasMediaDevices: false }), "unsupported");
  assert.equal(cameraSupport({ isSecureContext: true, hasMediaDevices: true }), null);
  assert.equal(cameraSupport({ hasMediaDevices: true }), null);
});

test("'Take a photo' uses getUserMedia, not a capture file input, and the gallery button is unchanged", () => {
  const editor = read("src/components/profile/ProfilePictureEditor.tsx");
  assert.ok(!/capture\s*=/.test(editor), "the old <input capture> (ignored on desktops) is gone");
  assert.match(editor, /CameraCaptureDialog/);
  assert.match(editor, /Upload \/ choose from gallery/);
  assert.match(editor, /aria-label="Choose a picture from your device"/);
  assert.match(editor, /chooseRef\.current\?\.click\(\)/);
  // the confirmed photo goes through the same validation / crop / upload as a gallery file
  assert.match(editor, /onUse=\{\(file\) => void onPick\(file\)\}/);
});

test("the camera dialog asks only on open, stops every track on every exit, and does not fall back to the gallery by itself", () => {
  const d = read("src/components/profile/CameraCaptureDialog.tsx");
  assert.match(d, /getUserMedia\(\{ video:/);
  assert.match(d, /audio: false/);
  assert.match(d, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
  assert.match(d, /aliveRef\.current = false;\s*stopCamera\(\);/, "unmount (navigation) stops the camera");
  assert.match(d, /if \(!aliveRef\.current \|\| run !== runRef\.current\) \{[\s\S]*?t\.stop\(\)/, "closing or restarting during the permission prompt does not leave a camera running");
  assert.match(d, /stopCamera\(\); \/\/ the still is taken/);
  assert.match(d, /e\.key === "Escape"/);
  assert.match(d, /role="dialog" aria-modal="true" aria-labelledby/);
  assert.ok(!/type="file"|\.click\(\)/.test(d), "no automatic file chooser");
});

test("the Permissions-Policy header lets the site's own pages use the camera, and nothing else", () => {
  const cfg = read("next.config.ts");
  const m = /key: "Permissions-Policy", value: "([^"]+)"/.exec(cfg);
  assert.ok(m);
  assert.match(m![1], /camera=\(self\)/);
  assert.ok(!/camera=\(\)/.test(m![1]), "camera=() would block getUserMedia for every visitor");
  for (const off of ["microphone=()", "geolocation=()", "payment=()"]) assert.ok(m![1].includes(off), off);
});

// ---- favicon ------------------------------------------------------------------------------------------------------------------
const pngSize = (b: Buffer) => ({ w: b.readUInt32BE(16), h: b.readUInt32BE(20), sig: b.subarray(0, 8).toString("hex") });

test("the favicon files are the DL monogram assets, at the right sizes", () => {
  const ico = bin("src/app/favicon.ico");
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, "an ICO file");
  const count = ico.readUInt16LE(4);
  assert.equal(count, 3);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    const png = ico.subarray(offset, offset + size);
    const p = pngSize(png);
    assert.equal(p.sig, "89504e470d0a1a0a");
    assert.equal(p.w, p.h);
    sizes.push(p.w);
  }
  assert.deepEqual(sizes, [16, 32, 48]);
  assert.notEqual(ico.length, 25931, "no longer the framework's default 25,931-byte starter icon");

  const apple = pngSize(bin("src/app/apple-icon.png"));
  assert.deepEqual([apple.w, apple.h], [180, 180]);
  const svg = read("src/app/icon.svg");
  assert.match(svg, /#1a56e8/, "the brand blue");
  assert.match(svg, /fill="#fff"/);
  assert.ok(!/triangle|polygon/i.test(svg));
});

test("social preview images are real 1200x630 pictures, separate from the favicon, and the metadata uses them", () => {
  for (const f of ["src/app/opengraph-image.png", "src/app/twitter-image.png"]) {
    const p = pngSize(bin(f));
    assert.deepEqual([p.w, p.h], [1200, 630], f);
    assert.ok(bin(f).length > 20_000, "a full picture, not an icon");
  }
  const layout = read("src/app/layout.tsx");
  assert.match(layout, /openGraph: \{ type: "website", siteName: "DIRECTOR\.LTD"/);
  assert.match(layout, /card: "summary_large_image"/);
  assert.match(layout, /metadataBase: metadataBase\(\)/);
  assert.match(layout, /process\.env\.APP_BASE_URL \|\| process\.env\.NEXTAUTH_URL/);
});

// ---- consent ------------------------------------------------------------------------------------------------------------------
test("consent matches what the app really uses: essential (always on) and embedded video only; no tracking anywhere in the source", () => {
  const ui = read("src/components/consent/CookieConsent.tsx");
  assert.match(ui, /Accept all/);
  assert.match(ui, /Reject non-essential/);
  assert.match(ui, /Cookie settings/);
  assert.match(ui, /Always on/);
  assert.match(ui, /Embedded videos \(YouTube, Vimeo\)/);
  assert.match(ui, /We do not use advertising or analytics cookies/);
  assert.match(ui, /Strictly necessary/);
  assert.match(ui, /role="dialog" aria-modal="true"/);
  assert.match(ui, /Escape/);

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(tsx?|jsx?)$/.test(e.name) && /(googletagmanager|google-analytics|gtag\(|fbq\(|hotjar|plausible\.io|segment\.com|mixpanel|clarity\.ms|doubleclick)/i.test(read(rel))) offenders.push(rel);
    }
  };
  walk("src");
  assert.deepEqual(offenders, [], "no analytics / advertising / tracking code exists, so none may be listed or gated");
});

test("every third-party video iframe is behind the consent gate; the banner is on the public homepage only; the footer can reopen the settings", () => {
  const sections = read("src/components/marketing/CustomSections.tsx");
  const iframes = sections.split("\n").flatMap((line, i, all) => (line.includes("<iframe") ? [all.slice(Math.max(0, i - 2), i + 1).join("\n")] : []));
  assert.equal(iframes.length, 2);
  for (const ctx of iframes) assert.match(ctx, /<ConsentGate provider=/, "iframe must sit directly inside ConsentGate");
  assert.ok(!/bypass/.test(sections), "the editor canvas renders the same as the public page, so there is no bypass");
  const gate = read("src/components/consent/ConsentGate.tsx");
  assert.match(gate, /getServerConsentSnapshot/, "server HTML and first render never contain the player");
  const home = read("src/app/page.tsx");
  assert.match(home, /<CookieConsent \/>/);
  assert.ok(!/CookieConsent/.test(read("src/components/marketing/HomeView.tsx")), "the CMS editor canvas / draft preview must not show the banner");
  assert.match(read("src/components/marketing/Footer.tsx"), /<CookieSettingsLink/);
});
