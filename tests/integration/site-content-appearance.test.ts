import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { BASE, db, sessionFor, type Session } from "./helpers";
import { contentHash } from "../../src/lib/site-content/canonical";
import { DEFAULT_SITE_CONTENT } from "../../src/lib/site-content/defaults";
import { toEditable, type EditableContent } from "../../src/lib/site-content/schema";
import { newSection } from "../../src/lib/site-content/editor-model";
import { DEFAULT_ORDER, customKey, defaultOrder } from "../../src/lib/site-content/styles";

after(async () => {
  await db.$disconnect();
});

// Real PostgreSQL + the production build (scratch only). Appearance settings, formatted text, the explicit section order and
// images inside text blocks: validated by the API, isolated in drafts, public only once published, restored exactly.

const images = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/images.json"), "utf8")) as Record<string, { mime: string; width: number; height: number; base64: string }>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const marker = (l: string) => `${l} ${randomUUID().slice(0, 8)}`;

// A small valid PNG with random pixels, so this file never reuses (or races with) an image another test file uploads.
function uniquePng(w = 24, h = 12): Buffer {
  const rgb = randomBytes(3);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w * 3 }, (_, i) => rgb[i % 3]))]);
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

interface Res {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}
async function raw(s: Session | null, p: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {}): Promise<Res & { text: string }> {
  const res = await fetch(`${BASE}${p}`, { method: init.method ?? "GET", headers: { origin: BASE, ...(s ? { cookie: `director_session=${s.cookie}` } : {}), ...init.headers }, body: init.body as BodyInit | undefined, redirect: "manual" });
  const text = Buffer.from(await res.arrayBuffer()).toString("utf8");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers, text };
}
const call = (s: Session | null, p: string, method: string, body?: unknown) => raw(s, p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const state = async (s: Session) => (await call(s, "/api/admin/website-content", "GET")).json.state;
const saveDraft = (s: Session, content: unknown, v: number) => call(s, "/api/admin/website-content/draft", "PUT", { content, expectedDraftVersion: v });
const publish = (s: Session, st: { draftVersion: number; publishedVersion: number }, note?: string) => call(s, "/api/admin/website-content/publish", "POST", { expectedDraftVersion: st.draftVersion, expectedPublishedVersion: st.publishedVersion, ...(note ? { note } : {}) });
async function publicWaitFor(pred: (html: string) => boolean, ms = 40_000): Promise<string | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const html = await (await fetch(`${BASE}/`)).text();
    if (pred(html)) return html;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}
const issuesOf = (r: Res) => JSON.stringify(r.json?.issues ?? r.json);

let sa: Session;
let base: EditableContent;
let draftV = 0;

test("setup: a Super Admin, and the page as it is now", async () => {
  sa = await sessionFor("SUPER_ADMIN", "appearance");
  const s = await state(sa);
  base = clone(s.editing as EditableContent);
  // Appearance and order are absent unless an editor set them.
  assert.equal("styles" in base, false);
  assert.equal("order" in base, false);
  draftV = s.draftVersion;
});

test("the draft API accepts valid appearance, formatting and order, and normalises colours to lower case", async () => {
  const c = clone(base);
  c.hero.intro = { runs: [{ text: "Alpha " }, { text: "bravo", b: true, color: "#2457E8", bg: "#FFF3B0", size: 28, font: "serif" }, { text: " charlie" }], align: "justify", lineHeight: 1.5, spaceAfter: 16 };
  c.styles = {
    buttons: { "hero.secondary": { href: "https://example.com/offer", newTab: true, bg: "#2457E8", color: "#FFFFFF", radius: 30 }, "hero.primary": { bg: "#101010" } },
    headings: { "faq.heading": { size: 24, color: "#112233", italic: true } },
    sections: { faq: { bg: "#F1F5F9", padTop: 40 } },
    rows: { "hero.buttons": { align: "left" } },
  };
  const order = [...DEFAULT_ORDER] as string[];
  const [x] = order.splice(1, 1);
  order.splice(3, 0, x);
  c.order = order;
  const r = await saveDraft(sa, c, draftV);
  assert.equal(r.status, 200, issuesOf(r));
  draftV = r.json.state.draftVersion;
  const stored = r.json.state.editing as EditableContent;
  assert.equal(stored.styles?.buttons?.["hero.secondary"]?.bg, "#2457e8");
  assert.equal(stored.styles?.sections?.faq?.bg, "#f1f5f9");
  assert.deepEqual(stored.order, order);
  assert.deepEqual((stored.hero.intro as { runs: { color?: string; bg?: string }[] }).runs[1].color, "#2457e8");
  const row = await db.siteContent.findUnique({ where: { key: "home" }, select: { draftJson: true } });
  assert.deepEqual((row?.draftJson as { order?: string[] }).order, order, "stored in the database exactly as validated");
});

test("hostile or malformed appearance, formatting and order are refused with located messages and change nothing", async () => {
  const before = (await state(sa)).draftVersion;
  const cases: [string, (c: any) => void, RegExp][] = [
    ["a destination on a sign-in button", (c) => (c.styles = { buttons: { "hero.primary": { href: "https://evil.example" } } }), /fixed in code/],
    ["a new-tab flag on a sign-in button", (c) => (c.styles = { buttons: { "final.primary": { newTab: true } } }), /fixed in code/],
    ["a javascript: destination", (c) => (c.styles = { buttons: { "hero.secondary": { href: "javascript:alert(1)" } } }), /https:\/\/|Use/],
    ["a http: destination", (c) => (c.styles = { buttons: { "hero.secondary": { href: "http://example.com" } } }), /https:\/\//],
    ["a css injection through a colour", (c) => (c.styles = { buttons: { "hero.secondary": { bg: "#000; position:fixed" } } }), /six-digit/],
    ["a named colour", (c) => (c.styles = { sections: { faq: { bg: "red" } } }), /six-digit/],
    ["an unknown style property", (c) => (c.styles = { buttons: { "hero.secondary": { transform: "scale(9)" } } }), /Unknown field/],
    ["an unknown element", (c) => (c.styles = { headings: { "nope.heading": { size: 20 } } }), /Unknown field/],
    ["a font outside the list", (c) => (c.hero.intro = { runs: [{ text: "x", font: "Arial" }] }), /font/],
    ["a text size out of range", (c) => (c.hero.intro = { runs: [{ text: "x", size: 500 }] }), /between 8 and 120/],
    ["a line height out of range", (c) => (c.hero.intro = { runs: [{ text: "x" }], lineHeight: 9 }), /Line height/],
    ["a rich colour that is not hex", (c) => (c.hero.intro = { runs: [{ text: "x", color: "rgb(1,2,3)" }] }), /six-digit/],
    ["an order without the hero first", (c) => (c.order = ["finalCta", ...DEFAULT_ORDER.slice(0, -1)]), /hero|final/],
    ["an order missing a section", (c) => (c.order = DEFAULT_ORDER.slice(1)), /exactly once/],
    ["an order with a made-up section", (c) => (c.order = DEFAULT_ORDER.map((k) => (k === "faq" ? "evil" : k))), /Unknown/],
    ["an order naming an added section that does not exist", (c) => (c.order = [...DEFAULT_ORDER.slice(0, -1), "custom:abcdef123456", "finalCta"]), /exactly once|Unknown/],
    ["spacing out of range", (c) => (c.styles = { sections: { faq: { padTop: 9999 } } }), /At most 240/],
    ["an image display size out of range", (c) => (c.custom = [{ id: "imgsection001", slot: "afterHero", type: "image", mediaId: "a".repeat(32), alt: "x", size: "medium", displayWidth: 99999 }]), /At most 1600/],
  ];
  for (const [name, mutate, why] of cases) {
    const c = clone(base);
    mutate(c);
    const r = await saveDraft(sa, c, before);
    assert.ok(r.status === 400 || r.status === 422, `${name}: status ${r.status} ${issuesOf(r)}`);
    assert.match(issuesOf(r), why, name);
  }
  assert.equal((await state(sa)).draftVersion, before, "none of them changed the draft");
});

test("a draft with appearance and a new order is invisible to the public page until it is published", async () => {
  const html = await (await fetch(`${BASE}/`)).text();
  assert.ok(html.indexOf('class="marquee mt-4"') < html.indexOf('id="uk-data"'), "the public page still has the original order");
  assert.ok(!html.includes("https://example.com/offer"));
  assert.ok(!html.includes("background-color:#2457e8"));
  const preview = await raw(sa, "/website-preview");
  assert.equal(preview.status, 200);
  assert.ok(preview.text.indexOf('class="marquee mt-4"') > preview.text.indexOf('id="uk-data"'), "the private preview uses the draft order");
  assert.ok(preview.text.includes("https://example.com/offer"));
});

let v1 = 0;

test("publishing makes the order, the buttons and the formatting public; sign-in buttons still go to sign in", async () => {
  const s = await state(sa);
  const r = await publish(sa, s, "appearance and order");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  v1 = r.json.version;
  const html = await publicWaitFor((h) => h.includes("https://example.com/offer"));
  assert.ok(html, "the new page is public");
  assert.ok(html.indexOf('class="marquee mt-4"') > html.indexOf('id="uk-data"'), "“Built for” now follows the UK register");
  assert.ok(html.indexOf('class="marquee mt-4"') < html.indexOf("Corporate structure</h2>"));
  assert.match(html, /target="_blank"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*target="_blank"/);
  assert.match(html, /<a style="[^"]*background-color:#2457e8[^"]*border-radius:30px"/);
  assert.match(html, /<span style="color:#2457e8;background-color:#fff3b0;/);
  assert.match(html, /<p [^>]*style="text-align:justify;line-height:1\.5;margin-bottom:16px"/);
  assert.match(html, /<section id="faq"[^>]*style="background:#f1f5f9;padding-top:40px"/);
  assert.match(html, /<a style="background-color:#101010"[^>]*href="\/login"/, "the sign-in button kept its look and its destination");
  assert.ok(!html.includes("evil.example"));
  assert.ok(!/data-cms/.test(html), "no editor markers on the public page");
});

test("an image used only inside a text block is private while a draft, public once published, and private again after a restore", async () => {
  const up = await raw(sa, "/api/admin/website-content/media", { method: "POST", headers: { "content-type": "image/png" }, body: uniquePng() });
  assert.equal(up.status === 200 || up.status === 201, true, JSON.stringify(up.json));
  const media = up.json.media;
  let s = await state(sa);
  const c: EditableContent = clone(s.editing);
  const t = newSection({ type: "text" }, "beforeFaq");
  if (t.type !== "text") throw new Error("text");
  t.title = marker("Text with picture");
  t.blocks = [{ kind: "image", mediaId: media.id, alt: "A block picture", caption: "Caption", width: media.width, height: media.height, displayWidth: 200, wrap: "left", align: "left", radius: 12 }, ...t.blocks];
  c.custom = [t];
  c.order = defaultOrder(c.custom).filter((k) => k !== customKey(t.id));
  c.order.splice(c.order.indexOf("faq") + 1, 0, customKey(t.id));
  const saved = await saveDraft(sa, c, s.draftVersion);
  assert.equal(saved.status, 200, issuesOf(saved));

  assert.equal((await raw(null, `/media/${media.id}`)).status, 404, "a draft-only block image is not public");
  assert.equal((await raw(sa, `/media/${media.id}`)).status, 200, "but the Super Admin can see it");
  assert.ok(!(await (await fetch(`${BASE}/`)).text()).includes(media.id));

  s = await state(sa);
  const pub = await publish(sa, s, "block image");
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  const html = await publicWaitFor((h) => h.includes(media.id));
  assert.ok(html, "the page shows the picture");
  assert.match(html, /<figure style="display:block;width:100%;max-width:200px;margin-left:auto;margin-right:auto" class="sm:float-left sm:mr-6 sm:mb-3">/);
  assert.ok(html.indexOf(media.id) > html.indexOf('id="faq"'), "and the added section follows the FAQ, as ordered");
  assert.equal((await raw(null, `/media/${media.id}`)).status, 200);

  // restore version 1 (no image): the image goes private again, but its row is still there
  const st = await state(sa);
  const back = await call(sa, "/api/admin/website-content/rollback", "POST", { toVersion: v1, expectedPublishedVersion: st.publishedVersion });
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.ok(await publicWaitFor((h) => !h.includes(media.id)));
  assert.equal((await raw(null, `/media/${media.id}`)).status, 404);
  assert.ok(await db.siteMedia.findUnique({ where: { id: media.id } }), "the image file is never deleted");
});

test("restoring a version brings back its content, formatting, buttons and order exactly (same canonical hash)", async () => {
  const st = await state(sa);
  const row = await db.siteContent.findUnique({ where: { key: "home" }, select: { publishedJson: true, publishedVersion: true } });
  const rev = await db.siteContentRevision.findFirst({ where: { contentKey: "home", version: v1 }, select: { contentHash: true } });
  assert.ok(rev && row?.publishedJson);
  assert.equal(contentHash(row.publishedJson), rev.contentHash, "the live JSON is exactly version 1's snapshot");
  const html = await publicWaitFor((h) => h.includes("https://example.com/offer") && h.indexOf('class="marquee mt-4"') > h.indexOf('id="uk-data"'));
  assert.ok(html);
  // history is complete and attributed
  const revs = st.revisions as { version: number; kind: string }[];
  assert.ok(revs.some((r) => r.version === v1 && r.kind === "publish"));
  assert.ok(revs.some((r) => r.kind === "rollback"));
});

test("a stale draft is a 409 and the revision rows of appearance changes are immutable", async () => {
  const s = await state(sa);
  const c = clone(s.editing as EditableContent);
  c.hero.intro = marker("late edit");
  const stale = await saveDraft(sa, c, s.draftVersion + 5);
  assert.equal(stale.status, 409);
  const rev = await db.siteContentRevision.findFirst({ where: { contentKey: "home", version: v1 }, select: { id: true } });
  assert.ok(rev);
  await assert.rejects(() => db.siteContentRevision.update({ where: { id: rev!.id }, data: { note: "changed" } }), /append-only|immutable|not allowed|cannot/i);
});

test("appearance changes never touch company records", async () => {
  const companies = await db.company.count();
  const s = await state(sa);
  const c = clone(s.editing as EditableContent);
  c.styles = { headings: { "hero.heading": { size: 70 } } };
  const r = await saveDraft(sa, c, s.draftVersion);
  assert.equal(r.status, 200, issuesOf(r));
  assert.equal(await db.company.count(), companies);
});

test("text looks, card captions, card looks and block layout save over the API; a live figure can never be written", async () => {
  const s = await state(sa);
  const c = clone(s.editing as EditableContent);
  c.styles = { texts: { "footer.tagline": { size: 20, color: "#FFD27F", italic: true } }, statCards: { bg: "#FFF7E6", radius: 24 }, headings: { "hero.heading": { accentItalic: true } } };
  c.ukRegister = { ...c.ukRegister, labels: { total: "Companies we hold" } };
  c.hero.intro = { runs: [{ text: "Spaced paragraph" }], boxWidth: 60, boxAlign: "right", spaceBefore: 12, padX: 8 };
  const saved = await saveDraft(sa, c, s.draftVersion);
  assert.equal(saved.status, 200, issuesOf(saved));
  const row = await db.siteContent.findUnique({ where: { key: "home" }, select: { draftJson: true } });
  const d = row?.draftJson as { styles: { texts: Record<string, { color: string }>; statCards: { bg: string } }; ukRegister: { labels: { total: string } } };
  assert.equal(d.styles.texts["footer.tagline"].color, "#ffd27f");
  assert.equal(d.styles.statCards.bg, "#fff7e6");
  assert.equal(d.ukRegister.labels.total, "Companies we hold");
  const html = (await raw(sa, "/website-preview")).text;
  assert.match(html, /Companies we hold/);
  assert.match(html, /font-size:1\.25rem;font-style:italic;color:#ffd27f/);
  assert.match(html, /<span class="sr-only">\d[\d,]*<\/span>/, "the figures still come from the database");
  const again = (await state(sa)).draftVersion;
  const refuse = async (mutate: (x: any) => void, why: RegExp) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const x = clone(c);
    mutate(x);
    const r = await saveDraft(sa, x, again);
    assert.ok(r.status === 400 || r.status === 422, issuesOf(r));
    assert.match(issuesOf(r), why);
  };
  await refuse((x) => (x.ukRegister.labels = { total: "5,779,656", count: "1" }), /Unknown/);
  await refuse((x) => (x.styles.statCards = { value: "9" }), /Unknown/);
  await refuse((x) => (x.styles.texts = { "<img src=x onerror=1>": { size: 12 } }), /key|valid/i);
  await refuse((x) => (x.styles.texts = { "footer.tagline": { color: "url(x)" } }), /six-digit/);
  await refuse((x) => (x.hero.intro = { runs: [{ text: "x" }], boxWidth: 500 }), /Width/);
  await refuse((x) => (x.hero.intro = { runs: [{ text: "x" }], boxAlign: "fixed" }), /Position/);
  assert.equal((await state(sa)).draftVersion, again, "none of the refused saves changed the draft");
});

test("per-card looks, picture slots and button/video blocks save over the API; slot pictures are private until published and never deleted", async () => {
  const up = await raw(sa, "/api/admin/website-content/media", { method: "POST", headers: { "content-type": "image/png" }, body: uniquePng(30, 20) });
  assert.equal(up.status === 200 || up.status === 201, true, JSON.stringify(up.json));
  const media = up.json.media;
  const s = await state(sa);
  const c = clone(s.editing as EditableContent);
  c.styles = { cards: { dissolved: { bg: "#FFF7E6", radius: 28, valueItalic: true, labelSize: 15 }, register: { radius: 10 } } };
  c.apart = { ...c.apart, circles: { "1": { mediaId: media.id, alt: "A circle picture" } } };
  c.useCases.items[0] = { ...c.useCases.items[0], image: { mediaId: media.id, alt: "A header picture", fit: "contain" } };
  const t = newSection({ type: "text" }, "beforeFaq");
  if (t.type !== "text") throw new Error("text");
  t.blocks = [...t.blocks, { kind: "button", label: "See offers", href: "https://example.com/offers", settings: { newTab: true } }, { kind: "video", provider: "youtube", videoId: "dQw4w9WgXcQ", title: "Intro" }];
  delete c.order; // the earlier test left an explicit order that names a different set of sections
  c.custom = [t];
  const saved = await saveDraft(sa, c, s.draftVersion);
  assert.equal(saved.status, 200, issuesOf(saved));
  assert.equal((await raw(null, `/media/${media.id}`)).status, 404, "a picture used only by a draft slot is private");
  assert.equal((await raw(sa, `/media/${media.id}`)).status, 200);
  const preview = (await raw(sa, "/website-preview")).text;
  assert.ok(preview.includes(media.id) && preview.includes("https://example.com/offers") && /This video is hosted by (<!-- -->)?YouTube/.test(preview) && !preview.includes("<iframe"));
  const again = (await state(sa)).draftVersion;
  const refuse = async (mutate: (x: any) => void, why: RegExp) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const x = clone(c);
    mutate(x);
    const r = await saveDraft(sa, x, again);
    assert.ok(r.status === 400 || r.status === 422, issuesOf(r));
    assert.match(issuesOf(r), why);
  };
  await refuse((x) => (x.styles.cards.total = { value: "5" }), /Unknown/);
  await refuse((x) => (x.styles.cards.bogus = { bg: "#ffffff" }), /Unknown/);
  await refuse((x) => (x.apart.circles["1"].mediaId = "../etc"), /Choose an image/);
  await refuse((x) => (x.apart.circles["7"] = { mediaId: media.id, alt: "x" }), /Unknown/);
  await refuse((x) => (x.useCases.items[0].image.mediaId = "f".repeat(32)), /no longer exists/);
  await refuse((x) => (x.custom[0].blocks[1].href = "javascript:alert(1)"), /https:\/\/|Use/);
  await refuse((x) => (x.custom[0].blocks[2].videoId = "bad"), /valid video id/);
  const pub = await publish(sa, await state(sa), "slot pictures");
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  assert.ok(await publicWaitFor((h) => h.includes(media.id) && h.includes("https://example.com/offers")));
  assert.equal((await raw(null, `/media/${media.id}`)).status, 200);
});

test("tidy up: leave a plain draft behind (no appearance, order or added sections) so later suites start from the built-in look", async () => {
  const s = await state(sa);
  const c = clone(s.editing as EditableContent);
  delete c.styles;
  delete c.order;
  c.custom = [];
  const r = await saveDraft(sa, c, s.draftVersion);
  assert.equal(r.status, 200, issuesOf(r));
  assert.equal("order" in r.json.state.editing, false);
});
