import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { PROTECTED_FAQ } from "@/lib/site-content/protected-claims";
import { CURRENT_SCHEMA_VERSION, parseEditableContent, toEditable, type EditableContent } from "@/lib/site-content/schema";
import { createPublishedContentReader, resolvePublishedContent, type PublishedRow } from "@/lib/site-content/reader";
import { HomeView } from "@/components/marketing/HomeView";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const editable = (): EditableContent => clone(toEditable(DEFAULT_SITE_CONTENT));
const row = (json: unknown, over: Partial<PublishedRow> = {}): PublishedRow => ({ publishedJson: json, publishedVersion: 3, schemaVersion: CURRENT_SCHEMA_VERSION, ...over });

test("no row, never published, or an empty row: the built-in defaults, by identity", () => {
  assert.equal(resolvePublishedContent(null).content, DEFAULT_SITE_CONTENT);
  assert.equal(resolvePublishedContent(row(null, { publishedVersion: 0 })).content, DEFAULT_SITE_CONTENT);
  assert.equal(resolvePublishedContent(row(editable(), { publishedVersion: 0 })).source, "defaults");
  assert.equal(resolvePublishedContent(null).source, "defaults");
});

test("valid published content is rendered, laid over the built-ins (destinations and protected pieces stay in code)", () => {
  const e = editable();
  e.hero.intro = "Published intro marker.";
  e.header.links[0].label = "Published nav";
  const r = resolvePublishedContent(row(e));
  assert.equal(r.source, "published");
  assert.equal(r.version, 3);
  assert.equal(r.content.hero.intro, "Published intro marker.");
  assert.equal(r.content.header.links[0].label, "Published nav");
  assert.deepEqual(r.content.header.links.map((l) => l.href), DEFAULT_SITE_CONTENT.header.links.map((l) => l.href));
});

test("stored content that is invalid in any way is ignored and the defaults are used instead", () => {
  const bad: unknown[] = [
    { ...editable(), stats: { total: 999999 } },
    (() => { const e = editable(); (e.hero as Record<string, unknown>).apiNote = "API live"; return e; })(),
    (() => { const e = editable(); e.hero.intro = "<script>alert(1)</script>"; return e; })(),
    (() => { const e = editable(); e.platform.cards.pop(); return e; })(),
    (() => { const e = editable(); e.faq.items.push({ q: PROTECTED_FAQ.ownership.q, a: "Yes, with keys." }); return e; })(),
    [],
    "text",
    42,
    {},
  ];
  for (const stored of bad) {
    const r = resolvePublishedContent(row(stored));
    assert.equal(r.source, "defaults", JSON.stringify(stored).slice(0, 80));
    assert.equal(r.content, DEFAULT_SITE_CONTENT);
    assert.ok(r.reason);
  }
});

test("content stored under another schema version is never rendered and is not rewritten", () => {
  const stored = row(editable(), { schemaVersion: CURRENT_SCHEMA_VERSION + 1 });
  const before = JSON.stringify(stored);
  assert.equal(resolvePublishedContent(stored).source, "defaults");
  assert.equal(JSON.stringify(stored), before, "the row is not mutated");
});

test("the reader falls back to the defaults on any database failure, including a missing table, without throwing", async () => {
  for (const err of [new Error("connection refused"), Object.assign(new Error("Invalid `prisma.siteContent.findUnique()` invocation:\n\nThe table `public.SiteContent` does not exist"), { code: "P2021" }), "boom", undefined]) {
    const read = createPublishedContentReader({ fetchRow: async () => { throw err; } });
    const r = await read("home");
    assert.equal(r.content, DEFAULT_SITE_CONTENT);
    assert.equal(r.source, "defaults");
  }
  const ok = await createPublishedContentReader({ fetchRow: async () => null })("home");
  assert.equal(ok.content, DEFAULT_SITE_CONTENT);
});

test("the reader's query can only see published columns: drafts cannot reach the public page", () => {
  const code = fs.readFileSync(path.join(__dirname, "../../src/lib/site-content/reader.ts"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/draft/i.test(code), "reader.ts must not mention draft columns");
  assert.match(code, /select:\s*\{\s*publishedJson: true, publishedVersion: true, schemaVersion: true\s*\}/);
  const page = fs.readFileSync(path.join(__dirname, "../../src/app/page.tsx"), "utf8").replace(/\/\/.*$/gm, "");
  assert.ok(!/draft/i.test(page));
});

const view = (content = DEFAULT_SITE_CONTENT, stats: Parameters<typeof HomeView>[0]["stats"] = { state: "unavailable" }) => renderToStaticMarkup(createElement(HomeView, { content, stats }));

test("HomeView renders the protected claims and database figures from code, whatever the content says", () => {
  const e = editable();
  e.hero.intro = "Marker intro for the published page.";
  e.faq.items = [{ q: "Marker question?", a: "Marker answer." }];
  const published = resolvePublishedContent(row(e)).content;
  const html = view(published, { state: "unavailable" });
  assert.ok(html.includes("Marker intro for the published page.") && html.includes("Marker question?"));
  for (const p of Object.values(PROTECTED_FAQ)) assert.ok(html.includes(p.q.replace(/&/g, "&amp;")), `protected question present: ${p.q}`);
  assert.ok(!/Is there an API?|Not yet. An API is planned|API not yet available|API planned, not yet available|Looking for API access|API coming soon|public API/.test(html), "no public-API promotion anywhere on the page (hero, section, FAQ)");
  assert.ok(!html.includes('id="api"') && !html.includes('href="#api"'), "no API section and no link to one");
  assert.ok(html.includes("Ownership data: DNL") && html.includes("Ownership data · planned"));
  assert.ok(html.includes("Live register figures are temporarily unavailable."));
  assert.ok(html.includes("Unavailable"), "last data sync stays unavailable");
  const ok = view(published, { state: "ok", register: { total: 40, active: 25, dissolved: 10, directorsConfirmed: 6, other: 5 }, dataAsOf: null });
  assert.ok(ok.includes(">40<") || ok.includes("40</span>") || ok.includes(">40"), "figures come from the stats object");
});

test("HomeView of the built-in content with the built-in FAQ keeps the original question order", () => {
  const html = view();
  const order = [DEFAULT_SITE_CONTENT.faq.items[0].q, PROTECTED_FAQ.updated.q, DEFAULT_SITE_CONTENT.faq.items[1].q, DEFAULT_SITE_CONTENT.faq.items[2].q, PROTECTED_FAQ.ownership.q].map((q) => html.indexOf(q.replace(/&/g, "&amp;").replace(/“/g, "“")));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("validated defaults: the built-in content itself passes the strict schema", () => {
  assert.ok(parseEditableContent(toEditable(DEFAULT_SITE_CONTENT)).ok);
});
