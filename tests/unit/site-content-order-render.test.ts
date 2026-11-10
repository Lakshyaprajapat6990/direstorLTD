import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichP, RunsP } from "@/components/marketing/RichText";
import { HomeView } from "@/components/marketing/HomeView";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@/lib/site-content/defaults";
import { applyEditable, toEditable, type EditableContent } from "@/lib/site-content/schema";
import { newSection } from "@/lib/site-content/editor-model";
import { DEFAULT_ORDER, customKey, defaultOrder, type OrderKey } from "@/lib/site-content/styles";
import type { PublicSiteStats } from "@/lib/data/public-stats";

const stats: PublicSiteStats = { state: "unavailable" };
const view = (content: SiteContent, editing = false) => renderToStaticMarkup(createElement(HomeView, { content, stats, editing }));
const base = (): EditableContent => toEditable(DEFAULT_SITE_CONTENT);
const page = (e: EditableContent, editing = false) => view(applyEditable(DEFAULT_SITE_CONTENT, e), editing);
const MEDIA = "c".repeat(32);
const D = DEFAULT_SITE_CONTENT;

// Where each built-in section starts in the markup (first marker that is unique to it).
const MARK: Record<string, string> = {
  hero: `<h1`,
  builtFor: `class="marquee mt-4"`,
  register: `id="uk-data"`,
  source: D.officialSource.heading,
  structure: `Corporate structure</h2>`,
  search: `id="search"`,
  filters: `id="filters"`,
  workflow: `id="workflow"`,
  platform: D.platform.heading,
  apart: `class="relative flex h-56 w-96`,
  useCases: D.useCases.eyebrow,
  faq: `id="faq"`,
  finalCta: D.finalCta.heading,
};
const at = (html: string, key: string) => {
  const i = html.indexOf(MARK[key]);
  assert.ok(i >= 0, `${key} is on the page`);
  return i;
};
// The public API section was removed: its key stays in the section registry (so stored orders stay valid) but renders nothing.
const rendered = (o: readonly string[]) => o.filter((k) => k !== "api");
const sequence = (html: string) => Object.keys(MARK).sort((a, b) => at(html, a) - at(html, b));

test("the markers used here identify each section once (so the order checks mean something)", () => {
  const html = page(base());
  for (const k of Object.keys(MARK)) assert.equal(html.split(MARK[k]).length - 1 >= 1, true, k);
  assert.deepEqual(sequence(html), rendered(DEFAULT_ORDER));
});

test("explicit order: the rendered page follows it, for built-in sections", () => {
  const e = base();
  // "Built for" below the UK register block (register, source), as in the editor request.
  const order = [...DEFAULT_ORDER] as string[];
  order.splice(1, 1);
  order.splice(3, 0, "builtFor");
  e.order = order;
  const html = page(e);
  assert.deepEqual(sequence(html), rendered(order));
  assert.ok(at(html, "builtFor") > at(html, "source"), "the strip is below the UK register and source card");
  assert.ok(at(html, "builtFor") < at(html, "structure"));
  assert.equal(html.split(`class="marquee mt-4"`).length - 1, 1, "the strip appears exactly once");
  const hero = html.slice(at(html, "hero"), at(html, "register"));
  assert.ok(!hero.includes("marquee"), "the hero no longer holds the strip");
});

test("explicit order: other sections move, the hero stays first and the call to action last", () => {
  const e = base();
  const o = [...DEFAULT_ORDER] as string[];
  const [faq] = o.splice(o.indexOf("faq"), 1);
  o.splice(o.indexOf("search"), 0, faq);
  e.order = o;
  const html = page(e);
  assert.deepEqual(sequence(html), rendered(o));
  assert.ok(at(html, "faq") < at(html, "search"));
  assert.equal(sequence(html)[0], "hero");
  assert.equal(sequence(html).at(-1), "finalCta");
});

test("the default order, written out explicitly, gives exactly the page with no stored order (also with added sections)", () => {
  const e = base();
  e.custom = [newSection({ type: "text" }, "afterHero"), newSection({ type: "cta" }, "beforeFaq"), newSection({ type: "faq" }, "afterFaq")];
  const without = page(e);
  e.order = defaultOrder(e.custom);
  assert.equal(page(e), without);
});

test("added sections follow the order too, wherever they were first placed", () => {
  const e = base();
  e.custom = [newSection({ type: "text" }, "afterHero")];
  const key = customKey(e.custom[0].id);
  e.custom[0] = { ...e.custom[0], title: "UNIQUE-ADDED-SECTION" } as never;
  const html0 = page(e);
  const idx0 = html0.indexOf("UNIQUE-ADDED-SECTION");
  assert.ok(idx0 > at(html0, "builtFor") && idx0 < at(html0, "register"), "without an order it sits at its slot: after the hero");
  const o = defaultOrder(e.custom).filter((k) => k !== key);
  o.splice(o.indexOf("faq") + 1, 0, key);
  e.order = o;
  const html = page(e);
  const idx = html.indexOf("UNIQUE-ADDED-SECTION");
  assert.ok(idx > at(html, "faq") && idx < at(html, "finalCta"), "dragged below the FAQ");
});

test("a stored order that is not valid is ignored: the page renders in the original order", () => {
  const e = base();
  const site = applyEditable(DEFAULT_SITE_CONTENT, e);
  for (const bad of [["finalCta", ...DEFAULT_ORDER.slice(0, -1)], DEFAULT_ORDER.slice(1), [...DEFAULT_ORDER, "faq"], DEFAULT_ORDER.map((k) => (k === "faq" ? "nope" : k))]) {
    assert.equal(view({ ...site, order: bad as string[] }), view(site));
  }
});

test("in the editor the sections carry their own markers; the public page never does", () => {
  const edit = page(base(), true);
  // (The "Built for" strip lives inside the hero, so it has its own marker only when it has been moved out of it.)
  for (const k of Object.keys(MARK).filter((k) => k !== "builtFor")) assert.match(edit, new RegExp(`data-cms="section:${k}"`), k);
  assert.ok(!/section:builtFor/.test(edit));
  const e = base();
  e.order = [...DEFAULT_ORDER.slice(0, 1), ...DEFAULT_ORDER.slice(2, 4), "builtFor", ...DEFAULT_ORDER.slice(4)];
  assert.match(page(e, true), /data-cms="section:builtFor"/);
  assert.ok(!/section:/.test(page(base())), "no editor markers in the public page");
});

// ---- appearance ----------------------------------------------------------------------------------------------------------------------

test("with no settings the markup has none of the new inline styles", () => {
  const html = page(base());
  assert.ok(!/<h1[^>]*style=/.test(html));
  assert.ok(!/<a [^>]*href="#uk-data"[^>]*style=/.test(html));
  assert.ok(!/id="faq"[^>]*style=/.test(html));
  assert.match(html, /<section class="border-b border-slate-100" style="background-image:radial-gradient/, "the hero keeps its dot pattern");
});

test("button settings reach the button; locked destinations cannot be changed even by hand-edited content", () => {
  const e = base();
  e.styles = { buttons: { "hero.secondary": { bg: "#2457e8", color: "#ffffff", radius: 30, padX: 44, href: "https://example.com/offer", newTab: true }, "hero.primary": { bg: "#101010", href: "https://evil.example" } as never } };
  const html = page(e);
  const secondary = [...html.matchAll(/<a [^>]*>(?:<span[^>]*>)?Explore UK data/g)].map((m) => m[0]).find((t) => t.includes("border-indigo-600")) ?? "";
  assert.match(secondary, /href="https:\/\/example\.com\/offer"/);
  assert.match(secondary, /target="_blank"/);
  assert.match(secondary, /rel="noopener noreferrer"/);
  assert.match(secondary, /background-color:#2457e8/);
  assert.match(secondary, /border-radius:30px/);
  assert.match(secondary, /padding-left:44px/);
  const primary = html.match(/<a [^>]*background-color:#101010[^>]*>/)?.[0] ?? "";
  assert.match(primary, /href="\/login"/);
  assert.ok(!/target=/.test(primary));
  assert.ok(!/evil/.test(html), "the locked button still goes to the sign-in page");
});

test("an overridden colour removes the matching !important class so the colour actually applies", () => {
  const e = base();
  const plain = page(e);
  assert.match(plain, /!bg-white/);
  e.styles = { buttons: { "final.primary": { bg: "#ff00aa" } } };
  const html = page(e);
  const btn = html.match(/<a [^>]*background-color:#ff00aa[^>]*>/)?.[0] ?? "";
  assert.ok(btn, "the final call-to-action button has the colour");
  assert.ok(!btn.includes("!bg-white") && !btn.includes("hover:!bg-blue-50"));
  assert.ok(btn.includes("!text-indigo-900"), "the text colour class stays, it was not overridden");
});

test("button rows align through justify-content, and a solo button through auto margins", () => {
  const e = base();
  e.styles = { rows: { "hero.buttons": { align: "left" } }, buttons: { "source.cta": { align: "right" } } };
  const html = page(e);
  assert.match(html, /style="justify-content:flex-start;align-items:flex-start"/);
  assert.match(html, /display:flex;width:fit-content;margin-left:auto;margin-right:0/);
});

test("heading settings: font, size (fluid), colour for the heading and for its highlighted part", () => {
  const e = base();
  e.styles = { headings: { "hero.heading": { size: 80, color: "#112233", accentColor: "#b45309", font: "serif", italic: true, weight: "bold", align: "left" }, "faq.heading": { size: 24 } } };
  const html = page(e);
  const h1 = html.match(/<h1[^>]*>/)?.[0] ?? "";
  assert.match(h1, /font-size:clamp\(2\.5rem, [\d.]+vw, 5rem\)/);
  assert.match(h1, /color:#112233/);
  assert.match(h1, /font-style:italic/);
  assert.match(h1, /text-align:left/);
  assert.match(html, /<span class="text-indigo-600" style="color:#b45309">/);
  assert.match(html, /<h2 [^>]*style="font-size:1\.5rem"[^>]*>Questions, answered\./);
});

test("section background replaces the section's own background; spacing only adds padding", () => {
  const e = base();
  e.styles = { sections: { faq: { bg: "#101010", padTop: 10 }, workflow: { bg: "#ffffff" }, hero: { padBottom: 0 }, search: { padTop: 5 } } };
  const html = page(e);
  assert.match(html, /<section id="faq" class="[^"]*" style="background:#101010;padding-top:10px">/);
  assert.match(html, /<section id="workflow" class="[^"]*" style="background:#ffffff">/);
  assert.match(html, /style="background-image:radial-gradient\(circle, #d6e2fb 1px, transparent 1px\);background-size:24px 24px;padding-bottom:0px"/, "the hero keeps its pattern when only spacing changes");
  assert.match(html, /<section id="search" class="[^"]*" style="padding-top:5px">/);
});

test("the workflow button takes its look through the client component", () => {
  const e = base();
  e.styles = { buttons: { "workflow.try": { bg: "#0f766e", radius: 2 } } };
  assert.match(page(e), /<a style="background-color:#0f766e;border-radius:2px"[^>]*href="\/login"/);
});

// ---- rich text -----------------------------------------------------------------------------------------------------------------------

test("free colours, highlights, numeric sizes and fonts render as inline values built from validated data", () => {
  const out = renderToStaticMarkup(createElement(RichP, { value: { runs: [{ text: "x", color: "#2457e8", bg: "#fff3b0", size: 22, font: "mono", b: true }], align: "justify", lineHeight: 1.5, spaceAfter: 16 } }));
  assert.match(out, /<p style="text-align:justify;line-height:1\.5;margin-bottom:16px">/);
  assert.match(out, /<strong><span style="color:#2457e8;background-color:#fff3b0;box-decoration-break:clone;padding:0 0\.15em;border-radius:0\.2em;font-size:1\.375rem;font-family:var\(--font-geist-mono\), ui-monospace, SFMono-Regular, Menlo, monospace">x<\/span><\/strong>/);
  // legacy palette keys still use classes
  assert.match(renderToStaticMarkup(createElement(RichP, { value: { runs: [{ text: "x", color: "brand", size: "lg" }] } })), /<span class="text-indigo-600 text-lg">x<\/span>/);
});

test("run text is escaped even next to styled values", () => {
  const out = renderToStaticMarkup(createElement(RunsP, { runs: [{ text: "<b onclick=x>&", color: "#112233" }], align: "justify", block: { lineHeight: 2 } }));
  assert.match(out, /&lt;b onclick=x&gt;&amp;/);
  assert.ok(!/<b /.test(out));
});

// ---- images ---------------------------------------------------------------------------------------------------------------------------

test("an image section with no display options renders exactly as before", () => {
  const e = base();
  const s = newSection({ type: "image", mediaId: MEDIA, alt: "Alt text", width: 800, height: 600 }, "afterHero");
  e.custom = [s];
  const html = page(e);
  assert.match(html, /<img src="\/media\/c{32}" alt="Alt text" width="800" height="600" loading="lazy" decoding="async" class="h-auto w-full rounded-2xl border border-slate-200 bg-slate-50"\/>/);
});

test("an image section with display options is sized, aligned and styled within its container", () => {
  const e = base();
  e.custom = [{ ...newSection({ type: "image", mediaId: MEDIA, alt: "Alt", width: 800, height: 600 }, "afterHero"), displayWidth: 320, displayHeight: 240, fit: "contain", align: "right", radius: 12 } as never];
  const html = page(e);
  assert.match(html, /<div style="display:block;width:100%;max-width:320px;margin-left:auto;margin-right:0">/);
  assert.match(html, /<img [^>]*style="display:block;width:100%;height:auto;aspect-ratio:320 \/ 240;object-fit:contain;border-radius:12px"/);
});

test("an image block sits between paragraphs and can wrap text; a wrapped block makes the container clear its float", () => {
  const e = base();
  e.custom = [{ id: "textsection01", slot: "beforeFaq", type: "text", blocks: [{ kind: "image", mediaId: MEDIA, alt: "Team", caption: "Us", width: 100, height: 50, displayWidth: 200, wrap: "left" }, { kind: "p", runs: [{ text: "Words that wrap" }] }] } as never];
  const html = page(e);
  assert.match(html, /<figure style="display:block;width:100%;max-width:200px;margin-left:auto;margin-right:auto" class="sm:float-left sm:mr-6 sm:mb-3">/);
  assert.match(html, /<figcaption [^>]*>Us<\/figcaption>/);
  assert.match(html, /class="space-y-4 flow-root"/);
  e.custom = [{ ...e.custom[0], blocks: [{ kind: "image", mediaId: MEDIA, alt: "Team" }] } as never];
  assert.ok(!/flow-root/.test(page(e)), "no float, no extra class");
});

test("an added button can have its own destination, opens safely in a new tab and drops the important class it overrides", () => {
  const e = base();
  e.custom = [{ ...newSection({ type: "cta" }, "afterHero"), button: { href: "https://example.com/x", newTab: true, bg: "#123456" } } as never];
  const html = page(e);
  const a = html.match(/<a [^>]*href="https:\/\/example\.com\/x"[^>]*>/)?.[0] ?? "";
  assert.ok(a, "the added button links to its own destination");
  assert.match(a, /target="_blank"/);
  assert.match(a, /rel="noopener noreferrer"/);
  assert.match(a, /background-color:#123456/);
  assert.ok(!a.includes("!bg-white"));
});
