import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CTA_TARGETS, SLOTS, ctaHref, embedUrl, parseVideoUrl } from "@/lib/site-content/sections";
import { MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, cleanFileName, readImageInfo } from "@/lib/site-content/image-info";
import { asFromCanvas, asToCanvas } from "@/lib/site-content/editor-protocol";

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/images.json"), "utf8")) as Record<string, { mime: string; width: number; height: number; base64: string }>;
const bytes = (k: string) => Uint8Array.from(Buffer.from(fixtures[k].base64, "base64"));

// ---- video addresses ------------------------------------------------------------------------------------------------------------

test("video addresses: only YouTube and Vimeo, only https, only well-formed ids", () => {
  const yt = (id = "dQw4w9WgXcQ") => ({ provider: "youtube", videoId: id });
  assert.deepEqual(parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), yt());
  assert.deepEqual(parseVideoUrl("https://youtube.com/watch?v=dQw4w9WgXcQ&t=10s"), yt());
  assert.deepEqual(parseVideoUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ"), yt());
  assert.deepEqual(parseVideoUrl("https://youtu.be/dQw4w9WgXcQ?si=abc"), yt());
  assert.deepEqual(parseVideoUrl("https://www.youtube.com/embed/dQw4w9WgXcQ"), yt());
  assert.deepEqual(parseVideoUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), yt());
  assert.deepEqual(parseVideoUrl("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"), yt());
  assert.deepEqual(parseVideoUrl("  https://vimeo.com/123456789  "), { provider: "vimeo", videoId: "123456789" });
  assert.deepEqual(parseVideoUrl("https://player.vimeo.com/video/123456789?h=abc"), { provider: "vimeo", videoId: "123456789" });
  for (const bad of [
    "",
    "not a url",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://evil.example/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ%22onload%3Dx",
    "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx",
    "https://vimeo.com/abc",
    "https://vimeo.com/12",
    "javascript:alert(1)",
    "https://www.dailymotion.com/video/x7tgad0",
  ]) {
    assert.equal(parseVideoUrl(bad), null, bad);
  }
});

test("embed addresses are built only from a provider and a validated id", () => {
  assert.equal(embedUrl("youtube", "dQw4w9WgXcQ"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(embedUrl("vimeo", "123456789"), "https://player.vimeo.com/video/123456789");
});

test("call-to-action buttons lead only to the fixed list of destinations", () => {
  assert.deepEqual(CTA_TARGETS.map((t) => t.href).sort(), ["#faq", "#filters", "#search", "#uk-data", "#workflow", "/login"]);
  assert.equal(ctaHref("login"), "/login");
  assert.equal(ctaHref("faq"), "#faq");
  assert.equal(SLOTS.length, 7);
});

// ---- images ---------------------------------------------------------------------------------------------------------------------

test("images are recognised from their bytes, with their real size", () => {
  for (const k of Object.keys(fixtures)) {
    const info = readImageInfo(bytes(k));
    assert.deepEqual(info, { type: fixtures[k].mime, width: fixtures[k].width, height: fixtures[k].height }, k);
  }
});

test("anything that is not a JPEG, PNG or WebP is refused, whatever it is called", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  for (const [name, data] of [
    ["svg", enc('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')],
    ["html", enc("<!doctype html><script>alert(1)</script>")],
    ["gif", enc("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;")],
    ["text", enc("hello")],
    ["empty", new Uint8Array(0)],
    ["exe", Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])],
    ["pdf", enc("%PDF-1.7 ...")],
  ] as const) {
    assert.equal(readImageInfo(data), null, name);
  }
});

test("truncated or tampered images do not crash the reader and are refused", () => {
  const png = bytes("png");
  for (const cut of [0, 1, 7, 8, 16, 23]) assert.equal(readImageInfo(png.slice(0, cut)), null, `png cut at ${cut}`);
  const jpeg = bytes("jpeg");
  for (const cut of [0, 2, 4, 10, 30]) assert.doesNotThrow(() => readImageInfo(jpeg.slice(0, cut)));
  const webp = bytes("webpLossy");
  for (const cut of [0, 12, 20, 29]) assert.equal(readImageInfo(webp.slice(0, cut)), null, `webp cut at ${cut}`);
  // a PNG that claims an absurd size is refused
  const huge = Uint8Array.from(png);
  new DataView(huge.buffer).setUint32(16, MAX_IMAGE_SIDE + 1);
  assert.equal(readImageInfo(huge), null);
  const zero = Uint8Array.from(png);
  new DataView(zero.buffer).setUint32(20, 0);
  assert.equal(readImageInfo(zero), null);
  // random bytes
  for (let i = 0; i < 50; i++) assert.doesNotThrow(() => readImageInfo(Uint8Array.from({ length: 64 }, () => Math.floor(Math.random() * 256))));
});

test("the size limits are what the migration enforces", () => {
  assert.equal(MAX_IMAGE_BYTES, 2 * 1024 * 1024);
  const sql = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20261024120000_site_media/migration.sql"), "utf8");
  assert.match(sql, /"byteSize" BETWEEN 1 AND 2621440/);
  assert.ok(MAX_IMAGE_BYTES < 2621440, "the application limit is inside the database limit");
});

test("file names are cleaned before they are stored or shown", () => {
  assert.equal(cleanFileName("Blue Banner.png"), "Blue Banner.png");
  assert.equal(cleanFileName("..\\..\\etc\\passwd"), ".._.._etc_passwd");
  assert.equal(cleanFileName("a/b/c.png"), "a_b_c.png");
  assert.equal(cleanFileName("evil<script>.png"), "evilscript.png");
  assert.equal(cleanFileName("nul\u0000byte.png"), "nulbyte.png");
  assert.equal(cleanFileName("%E2%9C%93%20ok.png"), "✓ ok.png");
  assert.equal(cleanFileName("x".repeat(300))?.length, 120);
  assert.equal(cleanFileName(""), null);
  assert.equal(cleanFileName(null), null);
  assert.equal(cleanFileName("   "), null);
});

// ---- editor <-> canvas messages ---------------------------------------------------------------------------------------------------

test("canvas messages: only the known shapes are understood", () => {
  assert.deepEqual(asToCanvas({ type: "cms:select", path: "hero.intro", scroll: true }), { type: "cms:select", path: "hero.intro", scroll: true });
  assert.deepEqual(asToCanvas({ type: "cms:select", path: 5 }), { type: "cms:select", path: null, scroll: false });
  assert.equal(asToCanvas({ type: "cms:content", content: { a: 1 } })?.type, "cms:content");
  for (const junk of [null, undefined, 5, "x", [], {}, { type: 5 }, { type: "other" }, { type: "cms:ready" }]) assert.equal(asToCanvas(junk), null);
  assert.deepEqual(asFromCanvas({ type: "cms:ready" }), { type: "cms:ready" });
  assert.deepEqual(asFromCanvas({ type: "cms:select", path: "x.y" }), { type: "cms:select", path: "x.y" });
  assert.deepEqual(asFromCanvas({ type: "cms:locked", reason: "r".repeat(1000) }), { type: "cms:locked", reason: "r".repeat(400) });
  for (const junk of [null, 5, {}, { type: "cms:locked" }, { type: "cms:locked", reason: 5 }, { type: "cms:content" }]) assert.equal(asFromCanvas(junk), null);
});
