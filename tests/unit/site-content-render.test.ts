import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichP, RunsP, renderRich } from "@/components/marketing/RichText";
import { HomeView } from "@/components/marketing/HomeView";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@/lib/site-content/defaults";
import { applyEditable, toEditable, type EditableContent } from "@/lib/site-content/schema";
import { describePath, getIn, newSection, outline, parsePath } from "@/lib/site-content/editor-model";
import type { PublicSiteStats } from "@/lib/data/public-stats";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const stats: PublicSiteStats = { state: "ok", register: { total: 40, active: 25, dissolved: 10, directorsConfirmed: 6, other: 5 }, dataAsOf: null };
const unavailable: PublicSiteStats = { state: "unavailable" };
const view = (content: SiteContent, s: PublicSiteStats = unavailable, editing = false) => html(createElement(HomeView, { content, stats: s, editing }));
const MEDIA = "c".repeat(32);

// ---- rich text rendering --------------------------------------------------------------------------------------------------------

test("a plain string renders as the bare string, exactly as before rich text existed", () => {
  assert.equal(html(createElement(RichP, { value: "Hello <world> & more", className: "x" })), '<p class="x">Hello &lt;world&gt; &amp; more</p>');
  assert.equal(html(createElement(RichP, { value: "Plain" })), "<p>Plain</p>");
});

test("formatted runs become strong / em / u / span / a, with fixed classes only", () => {
  const out = html(createElement(RichP, { value: { runs: [{ text: "a " }, { text: "bold", b: true }, { text: " " }, { text: "it", i: true }, { text: " " }, { text: "un", u: true }, { text: " " }, { text: "blue", color: "brand", size: "xl" }, { text: " " }, { text: "go", href: "/login" }] } }));
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>it<\/em>/);
  assert.match(out, /<u>un<\/u>/);
  assert.match(out, /<span class="text-indigo-600 text-xl">blue<\/span>/);
  assert.match(out, /<a href="\/login" class="[^"]*underline[^"]*">go<\/a>/);
  assert.ok(!/target=/.test(out), "internal links open in the same tab");
});

test("external links open safely; text is always escaped; nothing user-written reaches a style or class", () => {
  const out = html(createElement(RichP, { value: { runs: [{ text: "<img src=x onerror=alert(1)>", href: "https://example.com/?a=1&b=2", b: true }] } }));
  assert.match(out, /target="_blank"/);
  assert.match(out, /rel="noopener noreferrer"/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!/<img/.test(out));
  assert.match(out, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
});

test("alignment is applied as an inline text-align, only for the three keywords", () => {
  assert.match(html(createElement(RichP, { value: { runs: [{ text: "x", b: true }], align: "center" }, className: "c" })), /style="text-align:center"/);
  assert.ok(!/style=/.test(html(createElement(RichP, { value: "x" }))));
  assert.match(html(createElement(RunsP, { runs: [{ text: "x" }], align: "right", as: "h2" })), /<h2 style="text-align:right">x<\/h2>/);
});

test("renderRich on a string returns the string itself", () => {
  assert.equal(renderRich("same"), "same");
});

// ---- the homepage with and without added sections ------------------------------------------------------------------------------------

test("with no added sections the homepage is exactly the built-in page", () => {
  const e = toEditable(DEFAULT_SITE_CONTENT);
  assert.equal(view(applyEditable(DEFAULT_SITE_CONTENT, e)), view(DEFAULT_SITE_CONTENT));
});

test("public markup carries no editor markers at all", () => {
  const e = toEditable(DEFAULT_SITE_CONTENT);
  e.custom = [newSection({ type: "text" }, "afterHero"), newSection({ type: "cta" }, "afterFaq"), newSection({ type: "cards" }, "beforeFaq"), newSection({ type: "faq" }, "afterSearch"), newSection({ type: "video", provider: "youtube", videoId: "dQw4w9WgXcQ" }, "afterWorkflow"), newSection({ type: "image", mediaId: MEDIA, alt: "Alt", width: 640, height: 360 }, "afterPlatform")];
  const out = view(applyEditable(DEFAULT_SITE_CONTENT, e), stats);
  assert.ok(!/data-cms/.test(out));
  assert.ok(!/cms-editing/.test(out));
});

test("added sections appear in their slot, in list order within a slot, and the built-in sections keep their order", () => {
  const e = toEditable(DEFAULT_SITE_CONTENT);
  const a = newSection({ type: "text" }, "beforeFaq");
  const b = newSection({ type: "cta" }, "beforeFaq");
  const hero = newSection({ type: "faq" }, "afterHero");
  e.custom = [a, hero, b];
  const out = view(applyEditable(DEFAULT_SITE_CONTENT, e));
  const at = (needle: string) => out.indexOf(needle);
  assert.ok(at('id="section-' + hero.id) > at("Built for") && at('id="section-' + hero.id) < at('id="uk-data"'), "after the hero, before the register");
  assert.ok(at('id="section-' + a.id) > at('id="filters"') && at('id="section-' + a.id) < at('id="faq"'), "before the FAQ");
  assert.ok(at('id="section-' + a.id) < at('id="section-' + b.id), "list order within a slot");
  const builtIn = ['id="uk-data"', 'id="search"', 'id="filters"', 'id="workflow"', 'id="faq"'].map(at);
  assert.deepEqual([...builtIn].sort((x, y) => x - y), builtIn);
});

test("every added section type renders its content safely", () => {
  const e = toEditable(DEFAULT_SITE_CONTENT);
  e.custom = [
    { id: "txt0000001", slot: "afterHero", type: "text", title: "Text <b>title</b>", blocks: [{ kind: "h2", runs: [{ text: "Big" }] }, { kind: "p", runs: [{ text: "para " }, { text: "bold", b: true }], align: "center" }, { kind: "ul", items: [[{ text: "one" }], [{ text: "two", i: true }]] }, { kind: "ol", items: [[{ text: "first" }]] }] },
    { id: "img0000001", slot: "afterHero", type: "image", mediaId: MEDIA, alt: 'Alt "quoted"', caption: "Cap <i>", size: "wide", width: 640, height: 360 },
    { id: "vid0000001", slot: "afterHero", type: "video", provider: "vimeo", videoId: "123456789", title: "Vid", caption: "VC" },
    { id: "cta0000001", slot: "afterHero", type: "cta", heading: "CTA", text: { runs: [{ text: "go ", b: true }] }, buttonLabel: "Press", target: "faq", tone: "light" },
    { id: "crd0000001", slot: "afterHero", type: "cards", heading: "Cards", cards: [{ title: "C1", text: "T1" }, { title: "C2", text: { runs: [{ text: "T2", u: true }] } }] },
    { id: "faq0000001", slot: "afterHero", type: "faq", heading: "Qs", items: [{ q: "Why?", a: "Because." }, { q: "How?", a: "Like so." }] },
  ];
  const out = view(applyEditable(DEFAULT_SITE_CONTENT, e));
  assert.match(out, /Text &lt;b&gt;title&lt;\/b&gt;/);
  assert.ok(!/<b>title/.test(out));
  assert.match(out, /<h2[^>]*>Big<\/h2>/);
  assert.match(out, /<ul[^>]*><li>one<\/li><li><em>two<\/em><\/li><\/ul>/);
  assert.match(out, /<ol[^>]*><li>first<\/li><\/ol>/);
  assert.match(out, /<img src="\/media\/c{32}" alt="Alt &quot;quoted&quot;" width="640" height="360" loading="lazy"/);
  assert.match(out, /<figcaption[^>]*>Cap &lt;i&gt;<\/figcaption>/);
  // A video is held behind the cookie-consent gate: the server-rendered page holds a placeholder, never a live third-party player.
  assert.ok(!/<iframe/.test(out));
  assert.match(out, /This video is hosted by Vimeo, which may set cookies/);
  assert.match(out, /Allow videos/);
  assert.match(out, /<a [^>]*href="#faq"[^>]*>Press<\/a>/);
  assert.match(out, /<details[^>]*open=""[^>]*><summary[^>]*>Why\?/);
  assert.ok(!/<script/i.test(out));
});

test("an image or video section never produces an address that is not built from validated parts", () => {
  const e = toEditable(DEFAULT_SITE_CONTENT);
  e.custom = [{ id: "img0000001", slot: "afterHero", type: "image", mediaId: MEDIA, alt: "x", size: "medium" }, { id: "vid0000001", slot: "afterHero", type: "video", provider: "youtube", videoId: "dQw4w9WgXcQ", title: "t" }];
  const out = view(applyEditable(DEFAULT_SITE_CONTENT, e));
  const srcs = [...out.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((s) => /^https?:/.test(s) || s.startsWith("/media/"));
  for (const s of srcs) assert.match(s, /^(\/media\/[a-f0-9]{32}|https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11})$/);
});

// ---- the editor's view of the page is the public page ---------------------------------------------------------------------------------

// What the editor adds in editing mode: data-cms / data-cms-locked attributes, wrapper spans that carry only those, and the
// click shield over a video. Remove exactly that and the markup must equal the public page's, byte for byte.
function stripEditorMarkup(s: string): string {
  return s
    .replace(/<div class="absolute inset-0 z-10" data-cms="[^"]*"><\/div>/g, "")
    .replace(/<span data-cms="[^"]*">([\s\S]*?)<\/span>/g, "$1")
    .replace(/ data-cms(?:-locked)?="[^"]*"/g, "");
}

test("the editor's rendering of the page equals the public rendering once its own markers are removed (every state)", () => {
  const plain = applyEditable(DEFAULT_SITE_CONTENT, toEditable(DEFAULT_SITE_CONTENT));
  const e: EditableContent = toEditable(DEFAULT_SITE_CONTENT);
  e.hero.intro = { runs: [{ text: "Rich ", b: true }, { text: "intro", color: "brand", href: "/login" }], align: "center" };
  e.faq.items[0].a = { runs: [{ text: "Formatted answer", i: true }] };
  e.custom = [newSection({ type: "text" }, "beforeFaq"), newSection({ type: "cta" }, "afterHero"), newSection({ type: "cards" }, "afterPlatform"), newSection({ type: "faq" }, "afterFaq"), newSection({ type: "video", provider: "youtube", videoId: "dQw4w9WgXcQ" }, "afterSearch"), newSection({ type: "image", mediaId: MEDIA, alt: "A" }, "afterWorkflow")];
  const rich = applyEditable(DEFAULT_SITE_CONTENT, e);
  for (const content of [plain, rich]) {
    for (const s of [unavailable, stats, { state: "empty" } as PublicSiteStats]) {
      const publicHtml = view(content, s, false);
      const editorHtml = view(content, s, true);
      assert.notEqual(editorHtml, publicHtml, "editing mode really does add markers");
      assert.equal(stripEditorMarkup(editorHtml), publicHtml);
    }
  }
});

test("in editing mode every editable element is marked, and the code-controlled ones are marked as locked", () => {
  const e = toEditable(DEFAULT_SITE_CONTENT);
  e.custom = [newSection({ type: "text" }, "beforeFaq")];
  const out = view(applyEditable(DEFAULT_SITE_CONTENT, e), stats, true);
  const paths = new Set([...out.matchAll(/data-cms="([^"]+)"/g)].map((m) => m[1]));
  for (const p of ["hero.heading", "hero.intro", "hero.primaryCtaLabel", "hero.secondaryCtaLabel", "builtFor.label", "builtFor.audiences.0", "ukRegister.heading", "ukRegister.intro", "officialSource.text", "search.tabs.company.hint", "search.tabs.company.label", "search.tabs.company.fields.0", "filters.text", "workflow.tabs.lists.title", "workflow.tabs.lists.text", "workflow.tabs.lists.bullets.0", "workflow.steps.0", "workflow.tryLabel", "platform.cards.0.title", "platform.cards.7.text", "apart.talk.title", "apart.items.0.title", "useCases.items.2.tag", "faq.items.0.q", "faq.items.0.a", "finalCta.heading", "finalCta.primaryLabel", "header.links.0.label", "footer.tagline", "footer.links.5.label", "custom.0", "custom.0.title", "custom.0.blocks.0"]) {
    assert.ok(paths.has(p), `marked: ${p}`);
  }
  assert.ok((out.match(/data-cms-locked/g) ?? []).length >= 10, "statistics, API and ownership sections, notes and protected FAQ rows are locked");
  // the three protected FAQ rows are locked, never editable
  assert.ok(!paths.has(`faq.items.${DEFAULT_SITE_CONTENT.faq.items.length}.q`), "the protected rows do not get an editable index");
  assert.equal([...paths].filter((p) => /^faq\.items\.\d+\.q$/.test(p)).length, DEFAULT_SITE_CONTENT.faq.items.length);
});

test("the outline lists every editable text the page marks, so keyboard users can reach everything", () => {
  const e = toEditable(DEFAULT_SITE_CONTENT);
  const out = view(applyEditable(DEFAULT_SITE_CONTENT, e), stats, true);
  const marked = [...new Set([...out.matchAll(/data-cms="([^"]+)"/g)].map((m) => m[1]))].filter((p) => !p.startsWith("section:") && !p.startsWith("card:") && !p.startsWith("image:"));
  const listed = new Set(outline(e).flatMap((g) => g.items.map((i) => i.path)));
  assert.ok(listed.size > 100, `a long list (${listed.size})`);
  for (const p of marked) assert.ok(listed.has(p), `in the outline: ${p}`);
  for (const p of listed) {
    if (!p.startsWith("ukRegister.labels.")) assert.notEqual(getIn(e, parsePath(p)), undefined, `exists: ${p}`);
    assert.notEqual(describePath(e, p).kind, "none", `has an editor: ${p}`);
  }
  assert.ok(listed.has("search.tabs.filings.hint"), "includes text that is not on screen at first (other tabs)");
  assert.ok(![...listed].some((p) => /^faq\.items\.\d+\.q$/.test(p) && Number(p.split(".")[2]) >= DEFAULT_SITE_CONTENT.faq.items.length));
});
