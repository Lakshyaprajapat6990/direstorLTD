import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { BASE, db, login, sessionFor, createUser, STRONG_PASSWORD, type Session } from "./helpers";
import { ALL_PERMISSION_KEYS } from "../../src/lib/auth/permissions";
import { getPublishedSiteContentResolved } from "../../src/lib/site-content/reader";
import { DEFAULT_SITE_CONTENT } from "../../src/lib/site-content/defaults";
import { toEditable, type EditableContent } from "../../src/lib/site-content/schema";
import { newSection } from "../../src/lib/site-content/editor-model";

after(async () => {
  await db.$disconnect();
});

// Real PostgreSQL + the production build (scratch only). Covers the image library (upload rules, serving rules), added sections
// through the API, and the security headers that let the editor frame its own canvas and nothing else.

const images = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/images.json"), "utf8")) as Record<string, { mime: string; width: number; height: number; base64: string }>;
const bytes = (k: string) => Buffer.from(images[k].base64, "base64");
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const marker = (l: string) => `${l} ${randomUUID().slice(0, 8)}`;

interface Res {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
  text: string;
}
async function raw(s: Session | null, p: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer | string; noOrigin?: boolean } = {}): Promise<Res> {
  const res = await fetch(`${BASE}${p}`, {
    method: init.method ?? "GET",
    headers: { ...(init.noOrigin ? {} : { origin: BASE }), ...(s ? { cookie: `director_session=${s.cookie}` } : {}), ...init.headers },
    body: init.body as BodyInit | undefined,
    redirect: "manual",
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers, text };
}
const upload = (s: Session | null, body: Buffer, type = "image/png", extra: Record<string, string> = {}, noOrigin = false) => raw(s, "/api/admin/website-content/media", { method: "POST", headers: { "content-type": type, ...extra }, body, noOrigin });
const jsonCall = (s: Session | null, p: string, method: string, body?: unknown) => raw(s, p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const state = async (s: Session) => (await jsonCall(s, "/api/admin/website-content", "GET")).json.state;

async function pageRes(s: Session | null, p: string) {
  const res = await fetch(`${BASE}${p}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {}, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), headers: res.headers, text: await res.text() };
}

async function publicHas(text: string, ms = 40_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await (await fetch(`${BASE}/`)).text()).includes(text)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
async function publicLacks(text: string, ms = 40_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await (await fetch(`${BASE}/`)).text()).includes(text)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// ---- authorization ---------------------------------------------------------------------------------------------------------------

test("the image library API refuses everyone but a Super Admin, and refuses before reading anything", async () => {
  const user = await sessionFor("USER", "mediaauth");
  const legacyAdmin = await sessionFor("ADMIN", "mediaauth");
  const adminUser = await createUser("ADMIN", "mediafull");
  await db.user.update({ where: { id: adminUser.id }, data: { permissions: JSON.stringify(ALL_PERMISSION_KEYS) } });
  const fullAdmin = { cookie: (await login(adminUser.email, STRONG_PASSWORD)).cookie!, userId: adminUser.id, email: adminUser.email };
  const before = await db.siteMedia.count();

  assert.equal((await raw(null, "/api/admin/website-content/media")).status, 401);
  assert.equal((await upload(null, bytes("png"))).status, 401);
  for (const [who, s] of [["user", user], ["legacy admin", legacyAdmin], ["admin with every permission", fullAdmin]] as const) {
    assert.equal((await raw(s, "/api/admin/website-content/media")).status, 403, `${who} GET`);
    assert.equal((await upload(s, bytes("png"))).status, 403, `${who} POST`);
    assert.equal((await upload(s, Buffer.from("not an image"), "text/plain", {}, true)).status, 403, `${who} POST with a hostile request`);
  }
  assert.equal(await db.siteMedia.count(), before, "nothing was stored");
  assert.equal((await raw(await sessionFor("SUPER_ADMIN", "mediaauth"), "/api/admin/website-content/media")).status, 200);
});

// ---- upload rules -----------------------------------------------------------------------------------------------------------------

let sa: Session;

test("a PNG, a JPEG and a WebP upload; type, size and dimensions are read from the bytes; the same file is stored once", async () => {
  sa = await sessionFor("SUPER_ADMIN", "mediaflow");
  const stored: Record<string, string> = {};
  for (const k of ["png", "pngAlpha", "jpeg", "jpegProgressive", "webpLossy", "webpLossless", "webpAlpha"]) {
    const buf = Buffer.concat([bytes(k)]);
    const r = await upload(sa, buf, images[k].mime, { "x-file-name": encodeURIComponent(`My ${k} <file>.img`) });
    assert.equal(r.status, 201, `${k}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.reused, false);
    assert.match(r.json.media.id, /^[a-f0-9]{32}$/);
    assert.equal(r.json.media.width, images[k].width, k);
    assert.equal(r.json.media.height, images[k].height, k);
    assert.equal(r.json.media.mimeType, images[k].mime);
    assert.equal(r.json.media.originalName, `My ${k} file.img`, "the file name is cleaned");
    assert.equal(r.json.media.uploadedByName, (await db.user.findUniqueOrThrow({ where: { id: sa.userId } })).name);
    const row = await db.siteMedia.findUniqueOrThrow({ where: { id: r.json.media.id } });
    assert.ok(Buffer.compare(row.data, buf) === 0, `${k}: the stored bytes are the uploaded bytes`);
    stored[k] = r.json.media.id;
  }
  const again = await upload(sa, bytes("png"));
  assert.equal(again.status, 200);
  assert.equal(again.json.reused, true);
  assert.equal(again.json.media.id, stored.png);
  const list = await raw(sa, "/api/admin/website-content/media");
  assert.ok(list.json.media.some((m: { id: string }) => m.id === stored.png));
  assert.ok(list.json.media.every((m: Record<string, unknown>) => !("data" in m)), "the list never carries the bytes");
});

test("anything that is not a real JPEG, PNG or WebP is refused, whatever it claims to be", async () => {
  const before = await db.siteMedia.count();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  for (const [name, buf, type, status] of [
    ["svg declared as png", svg, "image/png", 415],
    ["html declared as jpeg", Buffer.from("<!doctype html><script>alert(1)</script>"), "image/jpeg", 415],
    ["gif declared as png", Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;"), "image/png", 415],
    ["an executable declared as webp", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0, 0, 0]), "image/webp", 415],
    ["truncated png", bytes("png").subarray(0, 20), "image/png", 415],
    ["png bytes declared as text", bytes("png"), "text/plain", 415],
    ["png bytes declared as svg", bytes("png"), "image/svg+xml", 415],
    ["png bytes with no type", bytes("png"), "", 415],
    ["empty body", Buffer.alloc(0), "image/png", 400],
  ] as const) {
    const r = await upload(sa, buf, type || "application/octet-stream");
    assert.equal(r.status, status, `${name}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.equal(await db.siteMedia.count(), before);
});

test("size and request hygiene: oversized bodies, a missing or foreign Origin", async () => {
  const before = await db.siteMedia.count();
  const huge = Buffer.concat([bytes("png"), randomBytes(2 * 1024 * 1024 + 100)]);
  assert.equal((await upload(sa, huge)).status, 413, "over the image limit");
  assert.equal((await upload(sa, Buffer.concat([bytes("png"), randomBytes(5 * 1024 * 1024)]))).status, 413, "far over: cut off while reading");
  assert.equal((await upload(sa, bytes("jpeg"), "image/jpeg", {}, true)).status, 403, "no Origin");
  assert.equal((await raw(sa, "/api/admin/website-content/media", { method: "POST", headers: { "content-type": "image/png", origin: "https://evil.example" }, body: bytes("png"), noOrigin: true })).status, 403, "foreign Origin");
  assert.equal(await db.siteMedia.count(), before);
});

// ---- who can see an image ---------------------------------------------------------------------------------------------------------

test("an image nobody has published is a 404 for visitors, and visible to a signed-in Super Admin only", async () => {
  const up = await upload(sa, Buffer.concat([bytes("webpLossy"), randomBytes(0)]), "image/webp");
  const id = up.json.media.id as string;
  assert.equal((await raw(null, `/media/${id}`)).status, 404);
  const user = await sessionFor("USER", "mediaview");
  assert.equal((await raw(user, `/media/${id}`)).status, 404, "signed-in non-admin");
  const admin = await sessionFor("ADMIN", "mediaview");
  assert.equal((await raw(admin, `/media/${id}`)).status, 404, "signed-in admin");
  const mine = await raw(sa, `/media/${id}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.headers.get("content-type"), "image/webp");
  assert.match(mine.headers.get("cache-control") ?? "", /private, no-store/);
  for (const bad of ["../../etc/passwd", "ZZZZ", "0".repeat(31), "0".repeat(33), "g".repeat(32), "0".repeat(32), "%2e%2e%2f"]) assert.equal((await raw(sa, `/media/${bad}`)).status, 404, bad);
});

// ---- added sections through the API -------------------------------------------------------------------------------------------------

test("added sections: every type saves; an image that does not exist is refused with its location", async () => {
  // Make sure something without these sections has been published first (when this file runs on its own there is no history).
  let s0 = await state(sa);
  if (s0.revisions.length === 0) {
    const plain: EditableContent = clone(s0.editing);
    plain.hero.intro = marker("baseline wording");
    const d = await jsonCall(sa, "/api/admin/website-content/draft", "PUT", { content: plain, expectedDraftVersion: s0.draftVersion });
    assert.equal(d.status, 200, JSON.stringify(d.json));
    const p = await jsonCall(sa, "/api/admin/website-content/publish", "POST", { expectedDraftVersion: d.json.state.draftVersion, expectedPublishedVersion: d.json.state.publishedVersion });
    assert.equal(p.status, 200, JSON.stringify(p.json));
  }
  s0 = await state(sa);
  const c: EditableContent = clone(s0.editing);
  const real = (await upload(sa, bytes("jpeg"), "image/jpeg")).json.media;
  c.custom = [
    newSection({ type: "text" }, "beforeFaq"),
    newSection({ type: "cta" }, "afterHero"),
    newSection({ type: "cards" }, "afterPlatform"),
    newSection({ type: "faq" }, "afterFaq"),
    newSection({ type: "video", provider: "youtube", videoId: "dQw4w9WgXcQ" }, "afterSearch"),
    newSection({ type: "image", mediaId: real.id, alt: "A test image", width: real.width, height: real.height }, "afterWorkflow"),
  ];
  const missing = clone(c);
  missing.custom[5] = { ...missing.custom[5], mediaId: "f".repeat(32) } as EditableContent["custom"][number];
  const refused = await jsonCall(sa, "/api/admin/website-content/draft", "PUT", { content: missing, expectedDraftVersion: s0.draftVersion });
  assert.equal(refused.status, 422);
  assert.ok(refused.json.issues.some((i: { path: string; message: string }) => i.path === "custom.5.mediaId" && /no longer exists/.test(i.message)), JSON.stringify(refused.json));

  const saved = await jsonCall(sa, "/api/admin/website-content/draft", "PUT", { content: c, expectedDraftVersion: s0.draftVersion });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  assert.equal(saved.json.state.editing.custom.length, 6);
});

test("a draft with added sections and an image is invisible to the public until it is published", async () => {
  const s = await state(sa);
  const intro = s.editing.custom.find((x: { type: string }) => x.type === "cta");
  const image = s.editing.custom.find((x: { type: string }) => x.type === "image");
  assert.ok(intro && image);
  const html = await (await fetch(`${BASE}/`)).text();
  assert.ok(!html.includes(image.mediaId), "the draft's image is not on the public page");
  assert.equal((await raw(null, `/media/${image.mediaId}`)).status, 404);
  assert.equal((await getPublishedSiteContentResolved("home")).content.custom?.some((x) => x.id === image.id) ?? false, false, "the public reader cannot see it");
  const preview = await pageRes(sa, "/website-preview");
  assert.ok(preview.text.includes(image.mediaId), "the Super Admin's private preview does");
  assert.ok(preview.text.includes(`id="section-${image.id}"`));
});

let publishedWithImage = 0;
let imageId = "";
let ctaHeading = "";

test("publishing makes the sections and the image public, with safe image headers and revalidation of the cache entry", async () => {
  const s = await state(sa);
  const image = s.editing.custom.find((x: { type: string }) => x.type === "image");
  const cta = s.editing.custom.find((x: { type: string }) => x.type === "cta");
  imageId = image.mediaId;
  ctaHeading = cta.heading;
  const r = await jsonCall(sa, "/api/admin/website-content/publish", "POST", { expectedDraftVersion: s.draftVersion, expectedPublishedVersion: s.publishedVersion, note: "sections and image" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  publishedWithImage = r.json.version;
  assert.equal(r.json.revalidated, true);

  assert.ok(await publicHas(`id="section-${image.id}"`), "the public homepage shows the image section");
  const pub = await (await fetch(`${BASE}/`)).text();
  assert.ok(pub.includes(`src="/media/${imageId}"`));
  // The video is held behind the cookie-consent gate: delivered HTML has the placeholder and no live third-party <iframe>.
  assert.ok(!pub.includes("<iframe") && /This video is hosted by (<!-- -->)?YouTube/.test(pub));
  assert.ok(pub.includes(ctaHeading));
  assert.ok(!/data-cms/.test(pub), "no editor markers on the public page");

  const media = await raw(null, `/media/${imageId}`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("content-type"), "image/jpeg");
  assert.equal(media.headers.get("x-content-type-options"), "nosniff");
  assert.match(media.headers.get("cache-control") ?? "", /public, max-age=31536000, immutable/);
  assert.equal(media.headers.get("content-disposition"), "inline");
  const etag = media.headers.get("etag")!;
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  const cached = await raw(null, `/media/${imageId}`, { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
});

test("restoring a version without the image takes the image off the public page and makes its address a 404 again", async () => {
  const s = await state(sa);
  const without = s.revisions.filter((r: { version: number }) => r.version < publishedWithImage).sort((a: { version: number }, b: { version: number }) => b.version - a.version)[0];
  assert.ok(without, "an earlier version exists");
  const r = await jsonCall(sa, "/api/admin/website-content/rollback", "POST", { toVersion: without.version, expectedPublishedVersion: s.publishedVersion });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(await publicLacks(`src="/media/${imageId}"`), "gone from the public page");
  assert.equal((await raw(null, `/media/${imageId}`)).status, 404);
  assert.equal((await raw(sa, `/media/${imageId}`)).status, 200, "the Super Admin can still use it");
  // and the old version with the image can still be restored: nothing was lost
  const s2 = await state(sa);
  const back = await jsonCall(sa, "/api/admin/website-content/rollback", "POST", { toVersion: publishedWithImage, expectedPublishedVersion: s2.publishedVersion });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.ok(await publicHas(`src="/media/${imageId}"`));
  assert.equal((await raw(null, `/media/${imageId}`)).status, 200);
});

// ---- security headers and the canvas page -------------------------------------------------------------------------------------------

test("only the editor canvas may be framed (same origin); every other page keeps DENY; embeds are limited to YouTube and Vimeo", async () => {
  for (const p of ["/", "/login", "/website-preview", "/admin/website-content", `/media/${imageId}`]) {
    const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
    assert.equal(r.headers.get("x-frame-options"), "DENY", p);
    const csp = r.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/, p);
    assert.match(csp, /frame-src 'self' https:\/\/www\.youtube-nocookie\.com https:\/\/player\.vimeo\.com(;|$)/, p);
    assert.match(csp, /img-src 'self' data: blob:/, p);
    assert.ok(!/frame-src[^;]*\*/.test(csp));
  }
  const canvas = await fetch(`${BASE}/website-preview/editor`, { redirect: "manual", headers: { cookie: `director_session=${sa.cookie}` } });
  assert.equal(canvas.status, 200);
  assert.equal(canvas.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(canvas.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
});

test("the canvas page is Super Admin only, uncached and not indexed", async () => {
  const user = await sessionFor("USER", "canvas");
  const admin = await sessionFor("ADMIN", "canvas");
  const anon = await pageRes(null, "/website-preview/editor");
  assert.ok([302, 303, 307, 308].includes(anon.status));
  assert.match(anon.location ?? "", /login|api\/auth\/expired/);
  for (const s of [user, admin]) {
    const r = await pageRes(s, "/website-preview/editor");
    assert.ok([302, 303, 307, 308].includes(r.status));
    assert.match(r.location ?? "", /dashboard/);
    assert.ok(!r.text.includes("canvas-root"));
  }
  const ok = await pageRes(sa, "/website-preview/editor");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control") ?? "", /no-store|no-cache|private/);
  assert.match(ok.text, /<meta name="robots" content="[^"]*noindex/);
});

test("the editor screen: Super Admin only, with the renamed tab last", async () => {
  const user = await sessionFor("USER", "screen");
  const admin = await sessionFor("ADMIN", "screen");
  for (const s of [user, admin]) {
    const r = await pageRes(s, "/admin/website-content");
    assert.ok([302, 303, 307, 308].includes(r.status));
    assert.match(r.location ?? "", /dashboard/);
  }
  const ok = await pageRes(sa, "/admin/website-content");
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Website Content \(CMS\)/);
  assert.match(ok.text, /Save draft/);
  assert.match(ok.text, /Publish/);
  const bar = ok.text.slice(ok.text.indexOf('aria-label="Super Admin sections"'));
  const tabs = [...bar.slice(0, bar.indexOf("</nav>")).matchAll(/<a[^>]*href="(\/admin[^"]*)"[^>]*>([^<]+)<\/a>/g)].map((m) => m[2]);
  assert.equal(tabs[tabs.length - 1], "Website Content (CMS)", JSON.stringify(tabs));
  assert.equal(tabs[tabs.indexOf("Column &amp; Default Settings") + 1], "Website Content (CMS)", "right after Column & Default Settings");
});

// ---- real company data stays untouched ------------------------------------------------------------------------------------------

test("nothing the editor does touches company records, statistics or the existing admin data", async () => {
  const snap = async () => ({
    companies: await db.company.count(),
    newest: (await db.company.aggregate({ _max: { updatedAt: true } }))._max.updatedAt?.toISOString() ?? null,
    columnLayouts: await db.columnLayout.count(),
    reports: await db.report.count(),
    runs: await db.ingestionRun.count(),
  });
  const before = await snap();
  await upload(sa, Buffer.concat([bytes("pngAlpha")]), "image/png");
  const s = await state(sa);
  const c: EditableContent = clone(s.editing);
  c.hero.intro = marker("untouched check");
  await jsonCall(sa, "/api/admin/website-content/draft", "PUT", { content: c, expectedDraftVersion: s.draftVersion });
  assert.deepEqual(await snap(), before);
});
