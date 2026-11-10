import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeView } from "@/components/marketing/HomeView";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { applyEditable, parseEditableContent, toEditable, type EditableContent } from "@/lib/site-content/schema";
import { describePath, newSection, outline, patchStatCards, patchStyle, setStatLabel } from "@/lib/site-content/editor-model";
import { toggleMark, setMark, normalizeRuns, richPlain, runsText, type Run } from "@/lib/site-content/rich";
import { STAT_LABEL_DEFAULTS, textKey } from "@/lib/site-content/styles";
import type { PublicSiteStats } from "@/lib/data/public-stats";

const stats: PublicSiteStats = { state: "ok", register: { total: 40, active: 25, dissolved: 10, directorsConfirmed: 6, other: 5 }, dataAsOf: null };
const base = (): EditableContent => JSON.parse(JSON.stringify(toEditable(DEFAULT_SITE_CONTENT)));
const page = (e: EditableContent, editing = false) => renderToStaticMarkup(createElement(HomeView, { content: applyEditable(DEFAULT_SITE_CONTENT, e), stats, editing }));
const ok = (c: unknown) => {
  const r = parseEditableContent(c);
  assert.ok(r.ok, r.ok ? "" : JSON.stringify(r.issues));
  return r.ok ? r.content : base();
};
const bad = (c: unknown, why?: RegExp) => {
  const r = parseEditableContent(c);
  assert.equal(r.ok, false);
  if (why) assert.match(JSON.stringify(r.ok ? [] : r.issues), why);
};

// ---- 1. formatting a selection never touches the words around it ----------------------------------------------------------------------

test("italic on a selected substring changes only that substring (rich text), for every mark", () => {
  const text = "UK Company Data Solutions for Research & CRM";
  const start = text.indexOf("Research");
  const runs: Run[] = [{ text }];
  for (const mark of ["i", "b", "u"] as const) {
    const out = toggleMark(runs, start, text.length, mark);
    assert.equal(runsText(out), text, "text is unchanged");
    assert.deepEqual(
      out.map((r) => [r.text, !!r[mark]]),
      [["UK Company Data Solutions for ", false], ["Research & CRM", true]]
    );
    assert.deepEqual(normalizeRuns(toggleMark(out, start, text.length, mark)), [{ text }], "toggling again removes it");
  }
  const styled = setMark([{ text: "keep ", b: true }, { text: "me and others" }], 5, 7, { color: "#112233", bg: "#ffeeaa", size: 30, font: "serif", href: "https://example.com" });
  assert.deepEqual(
    styled.map((r) => [r.text, r.b === true, r.color ?? null]),
    [["keep ", true, null], ["me", false, "#112233"], [" and others", false, null]]
  );
  assert.equal(richPlain({ runs: styled }), "keep me and others");
});

test("headings are plain text in two parts: italic, weight and font can be set for the whole heading, the first part or the highlighted part only", () => {
  const e = base();
  e.styles = { headings: { "hero.heading": { accentItalic: true } } };
  const html = page(e);
  const h1 = html.match(/<h1[^>]*>/)?.[0] ?? "";
  assert.ok(!/font-style/.test(h1), "the heading as a whole is not italic");
  assert.match(html, /<span class="text-indigo-600" style="font-style:italic"><span><span class="hero-word"/, "only the highlighted part is");
  assert.ok(!/<h1[^>]*><span style/.test(html), "the first part is not wrapped, so not italic");
  e.styles = { headings: { "hero.heading": { leadItalic: true, leadWeight: "bold", accentFont: "serif" } } };
  const h2 = page(e);
  assert.match(h2, /<h1[^>]*><span style="font-weight:700;font-style:italic"><span><span class="hero-word" style="--i:0">UK/);
  assert.match(h2, /<span class="text-indigo-600" style="font-family:Georgia/);
  e.styles = { headings: { "hero.heading": { italic: true } } };
  assert.match(page(e).match(/<h1[^>]*>/)?.[0] ?? "", /font-style:italic/, "the whole-heading setting still works");
  e.styles = { headings: { "useCases.heading": { accentItalic: true, leadFont: "mono" } } };
  assert.match(page(e), /<span class="text-indigo-600" style="font-style:italic">/);
  assert.equal(page(base()), page({ ...base(), styles: undefined } as EditableContent), "no settings: unchanged markup");
});

test("part-of-heading settings validate and nothing else is accepted", () => {
  const e = base();
  e.styles = { headings: { "hero.heading": { leadItalic: true, accentWeight: "bold", accentFont: "serif", leadFont: "mono", leadWeight: "normal", accentItalic: true } } };
  ok(e);
  bad({ ...base(), styles: { headings: { "hero.heading": { accentFont: "Comic Sans" } } } });
  bad({ ...base(), styles: { headings: { "hero.heading": { leadItalic: "yes" } } } });
});

// ---- 3. every plain-text element has a look --------------------------------------------------------------------------------------------

test("any plain-text element can take a look; text of added sections is keyed by section id so reordering cannot move it", () => {
  const e = base();
  e.custom = [newSection({ type: "cards" }, "beforeFaq")];
  const id = e.custom[0].id;
  assert.equal(textKey("custom.0.cards.0.title", e.custom), `custom:${id}.cards.0.title`);
  assert.equal(textKey("footer.tagline", e.custom), "footer.tagline");
  e.styles = { texts: { "footer.tagline": { color: "#ffffff", size: 20, italic: true }, "builtFor.audiences.1": { weight: "bold" }, "search.eyebrow": { color: "#b45309" }, [`custom:${id}.cards.0.title`]: { color: "#112233" } } };
  const html = page(ok(e));
  assert.match(html, /style="font-size:1\.25rem;font-style:italic;color:#ffffff"/, "footer tagline");
  assert.equal((html.match(/style="font-weight:700"/g) ?? []).length, 2, "an audience in both copies of the marquee");
  assert.match(html, /style="color:#b45309"/);
  assert.match(html, /<p class="text-xl font-bold text-indigo-900" style="color:#112233">/);
  e.custom = [newSection({ type: "text" }, "afterHero"), ...e.custom];
  assert.match(page(ok(e)), /<p class="text-xl font-bold text-indigo-900" style="color:#112233">/, "moving the section does not move the look");
  assert.match(page(e, true), /data-cms="search\.eyebrow"[^>]*style="color:#b45309"|style="color:#b45309"[^>]*data-cms="search\.eyebrow"/);
});

test("texts styles: keys must look like content paths, values are the same bounded look as headings", () => {
  const t = (v: unknown) => ({ ...base(), styles: { texts: v } });
  ok(t({ "footer.tagline": { size: 18 } }));
  bad(t({ "<script>": { size: 18 } }), /Invalid key|valid text/);
  bad(t({ "a b": { size: 18 } }), /Invalid key|valid text/);
  bad(t({ "footer.tagline": { size: 18, css: "x" } }), /Unknown/);
  bad(t({ "footer.tagline": { color: "red" } }), /six-digit/);
  bad(t(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`a${i}.b`, { size: 12 }]))), /At most 100/);
  assert.equal("styles" in ok(t({ "footer.tagline": {} })), false, "empty looks are dropped");
});

test("header and footer labels, buttons and statistic captions each open the right panel", () => {
  const c = base();
  assert.equal(describePath(c, "footer.tagline").kind, "plain");
  assert.equal(describePath(c, "footer.links.0.label").kind, "plain");
  assert.equal(describePath(c, "header.links.1.label").kind, "plain");
  assert.equal(describePath(c, "builtFor.audiences.0").kind, "plain");
  assert.equal(describePath(c, "ukRegister.labels.total").kind, "statLabel");
  assert.equal(describePath(c, "ukRegister.labels.nope").kind, "none");
  assert.deepEqual(describePath(c, "card:stat.dissolved"), { kind: "statCard", card: "dissolved" });
  assert.deepEqual(describePath(c, "card:register"), { kind: "statCard", card: "register" });
  assert.equal(describePath(c, "card:stats").kind, "none");
  assert.equal(describePath(c, "hero.secondaryCtaLabel").kind, "button");
});

// ---- 4. statistics cards -------------------------------------------------------------------------------------------------------------

test("captions of the figure cards are editable and the live figures are not: values always come from the data", () => {
  const e = base();
  e.ukRegister = { ...e.ukRegister, labels: { total: "Companies we hold", sync: "Latest refresh", cardCaption: "companies in our database" } };
  const html = page(ok(e));
  assert.match(html, /Companies we hold/);
  assert.match(html, /Latest refresh/);
  assert.match(html, /companies in our database/);
  assert.ok(!html.includes("UK companies loaded"), "the caption was replaced");
  assert.match(html, /<span class="sr-only">40<\/span>/, "the figure is still the live 40");
  assert.match(html, /Active<\/p>/, "untouched captions keep their wording");
  bad({ ...base(), ukRegister: { ...base().ukRegister, labels: { total: "12345", figure: "9" } } }, /Unknown/);
  bad({ ...base(), ukRegister: { ...base().ukRegister, labels: { total: "<b>x</b>" } } });
  bad({ ...base(), ukRegister: { ...base().ukRegister, labels: { total: "x".repeat(61) } } }, /Too long/);
  assert.equal(page(base()), page({ ...base(), ukRegister: { ...base().ukRegister, labels: undefined } } as EditableContent));
});

test("figure cards take a card look and a figure look, without changing what the figure says", () => {
  const e = base();
  e.styles = { statCards: { bg: "#F1F5F9", borderColor: "#0B2A6F", borderWidth: 2, radius: 24, padX: 30, padY: 28, align: "center", valueColor: "#B45309", valueSize: 40, valueWeight: "extrabold", labelColor: "#334155" } };
  const html = page(ok(e));
  assert.match(html, /<div class="min-w-0 rounded-xl border border-slate-200 bg-white px-4 py-4" style="background-color:#f1f5f9;border-style:solid;border-color:#0b2a6f;border-width:2px;border-radius:24px;padding-left:30px;padding-right:30px;padding-top:28px;padding-bottom:28px;text-align:center">/);
  assert.match(html, /<p class="break-words[^"]*" style="color:#b45309;font-size:[^;]*;font-weight:800"><span class="sr-only">40<\/span>/);
  assert.match(html, /class="mt-1 text-sm text-slate-500" style="color:#334155"/);
  assert.equal(parseEditableContent({ ...base(), styles: { statCards: { bg: "red" } } }).ok, false);
  assert.equal(parseEditableContent({ ...base(), styles: { statCards: { value: "99" } } }).ok, false, "there is no key for a figure");
  assert.equal(parseEditableContent({ ...base(), styles: { statCards: { radius: 99 } } }).ok, false);
});

test("model helpers: captions fall back to the built-in wording, card looks prune, outline lists the captions", () => {
  let c = setStatLabel(base(), "active", "Live companies");
  assert.deepEqual(c.ukRegister.labels, { active: "Live companies" });
  c = setStatLabel(c, "active", undefined);
  assert.equal("labels" in c.ukRegister, false);
  c = patchStatCards(base(), { bg: "#ffffff", radius: 8 });
  assert.deepEqual(c.styles, { statCards: { bg: "#ffffff", radius: 8 } });
  assert.equal("styles" in patchStatCards(patchStatCards(c, { bg: undefined }), { radius: undefined }), false);
  assert.equal(patchStyle(base(), "texts", "footer.tagline", { size: 20 }).styles?.texts?.["footer.tagline"]?.size, 20);
  const items = outline(base()).find((g) => g.section === "UK register section")!.items.map((i) => i.path);
  for (const k of Object.keys(STAT_LABEL_DEFAULTS)) assert.ok(items.includes(`ukRegister.labels.${k}`), k);
});

test("in the editor the figures are locked, the captions and the card carry editor markers", () => {
  const html = page(base(), true);
  assert.match(html, /data-cms="ukRegister\.labels\.total"/);
  assert.match(html, /data-cms="card:stat\.total"/);
  assert.match(html, /data-cms="card:register"/);
  assert.match(html, /data-cms-locked="This is a live figure/);
  assert.ok(!/data-cms/.test(page(base())), "none in the public page");
});

// ---- 7. block position and spacing ---------------------------------------------------------------------------------------------------

test("a paragraph can be spaced, padded, narrowed and placed left/right without any free-form css", () => {
  const e = base();
  e.hero.intro = { runs: [{ text: "Hello there" }], align: "justify", spaceBefore: 8, spaceAfter: 20, padX: 12, boxWidth: 60, boxAlign: "left" };
  const out = ok(e);
  assert.deepEqual(out.hero.intro, e.hero.intro);
  assert.match(page(out), /<p [^>]*style="text-align:justify;margin-bottom:20px;margin-top:8px;padding-left:12px;padding-right:12px;max-width:60%;margin-left:0;margin-right:auto"/);
  for (const extra of [{ boxWidth: 29 }, { boxWidth: 101 }, { padX: -1 }, { spaceBefore: 97 }, { boxAlign: "justify" }, { boxAlign: "calc(1px)" }, { spaceBefore: 1.5 }]) {
    bad({ ...base(), hero: { ...base().hero, intro: { runs: [{ text: "x" }], ...extra } } });
  }
  const c = base();
  c.custom = [{ id: "textsection01", slot: "beforeFaq", type: "text", blocks: [{ kind: "p", runs: [{ text: "Hi" }], spaceBefore: 10, padX: 20, boxWidth: 70, boxAlign: "right" }] } as never];
  assert.match(page(ok(c)), /margin-top:10px;padding-left:20px;padding-right:20px;max-width:70%;margin-left:auto;margin-right:0/);
  bad({ ...c, custom: [{ ...c.custom[0], blocks: [{ kind: "p", runs: [{ text: "Hi" }], boxWidth: 5 }] }] });
});
