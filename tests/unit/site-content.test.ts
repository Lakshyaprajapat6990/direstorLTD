import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@/lib/site-content/defaults";
import { PROTECTED_FAQ, composeFaq } from "@/lib/site-content/protected-claims";
import { cycle, splitWords } from "@/lib/site-content/helpers";
import { MarketingHeader } from "@/components/marketing/Header";
import { MarketingFooter } from "@/components/marketing/Footer";
import { SearchShowcase, WorkflowShowcase } from "@/components/marketing/LandingTabs";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

// ---- defaults are pinned -------------------------------------------------------------------------------------------

test("the default wording equals the pinned copy that Phase 1 verified against the original page", () => {
  const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/site-content-defaults.json"), "utf8"));
  assert.deepEqual(DEFAULT_SITE_CONTENT, golden);
});

test("composeFaq keeps the published FAQ order: update frequency second, ownership last (no API entry)", () => {
  const qs = composeFaq(DEFAULT_SITE_CONTENT.faq.items).map((i) => i.q);
  assert.deepEqual(qs, [
    "Where does the data come from?",
    "How often is it updated?",
    "What does “not fetched” mean for directors?",
    "Can I export results?",
    "Do you hold ownership or corporate hierarchy data?",
  ]);
});

test("composeFaq cannot drop or replace the protected claims, whatever the editable list holds", () => {
  for (const editable of [[], [{ q: "Only one", a: "x" }], [{ q: "Is there an API?", a: "Yes, with keys." }]]) {
    const out = composeFaq(editable);
    assert.ok(out.includes(PROTECTED_FAQ.updated));
    assert.ok(out.includes(PROTECTED_FAQ.ownership));
    assert.equal(out[out.length - 1], PROTECTED_FAQ.ownership);
  }
});

test("the editable defaults hold no protected claim and no markup", () => {
  const json = JSON.stringify(DEFAULT_SITE_CONTENT);
  for (const p of Object.values(PROTECTED_FAQ)) assert.ok(!json.includes(p.a), `protected answer leaked into defaults: ${p.q}`);
  assert.ok(!/[<>]/.test(json), "defaults must be plain text");
});

test("fixed-shape content keeps its expected counts", () => {
  const c = DEFAULT_SITE_CONTENT;
  assert.equal(c.workflow.steps.length, 5);
  assert.equal(c.platform.cards.length, 8);
  assert.equal(c.apart.items.length, 4);
  assert.equal(c.useCases.items.length, 3);
  assert.equal(c.builtFor.audiences.length, 5);
  assert.deepEqual(splitWords(c.hero.heading.lead), ["UK", "Company", "Data", "Solutions", "for"]);
});

// ---- layout helpers ------------------------------------------------------------------------------------------------

test("splitWords ignores leading, trailing and repeated spaces and never yields empty words", () => {
  assert.deepEqual(splitWords("UK Company Data Solutions for"), ["UK", "Company", "Data", "Solutions", "for"]);
  assert.deepEqual(splitWords("  Research   &  CRM \n"), ["Research", "&", "CRM"]);
  assert.deepEqual(splitWords(""), []);
  assert.deepEqual(splitWords("   "), []);
});

test("cycle wraps around instead of returning undefined", () => {
  const tones = ["a", "b", "c"] as const;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((i) => cycle(tones, i)), ["a", "b", "c", "a", "b", "c", "a"]);
  assert.equal(cycle(tones, -1), "c");
});

// ---- components take content through props, defaults otherwise ------------------------------------------------------

test("Header, Footer and both showcases render identically with no props and with the default content passed in", () => {
  const c = DEFAULT_SITE_CONTENT;
  assert.equal(html(createElement(MarketingHeader)), html(createElement(MarketingHeader, { content: c.header })));
  assert.equal(html(createElement(MarketingFooter)), html(createElement(MarketingFooter, { content: c.footer })));
  assert.equal(html(createElement(SearchShowcase)), html(createElement(SearchShowcase, { content: c.search.tabs })));
  assert.equal(html(createElement(WorkflowShowcase)), html(createElement(WorkflowShowcase, { content: c.workflow })));
});

test("navigation keeps its destinations: header and footer section links, and the sign-in link", () => {
  const anchors = (markup: string) => [...markup.matchAll(/href="(#[a-z-]+)"/g)].map((m) => m[1]);
  // The link to the removed API section is not shown (the stored link list still has its entry, by position).
  const expected = ["#uk-data", "#search", "#filters", "#workflow", "#faq"];
  const header = html(createElement(MarketingHeader));
  const footer = html(createElement(MarketingFooter));
  assert.ok(header.includes('href="/login"') && footer.includes('href="/login"'));
  // The header's own "Explore UK data" button comes first, then the desktop section row (the mobile menu is closed, so not rendered).
  assert.deepEqual(anchors(header), ["#uk-data", ...expected]);
  assert.deepEqual(anchors(footer), expected);
});

test("content passed through props is what renders, and nothing else changes", () => {
  const c = clone<SiteContent>(DEFAULT_SITE_CONTENT);
  c.header.links[0].label = "Header marker";
  c.footer.tagline = "Footer marker tagline";
  c.footer.links[1].label = "Footer link marker";
  c.search.tabs.company.hint = "Search hint marker";
  c.search.tabs.company.fields = ["Field marker A", "Field marker B"];
  c.workflow.tryLabel = "Try marker";
  c.workflow.steps = ["S one", "S two", "S three", "S four", "S five"];
  c.workflow.tabs.lists.title = "List title marker";
  c.workflow.tabs.lists.bullets = ["Bullet marker"];

  const header = html(createElement(MarketingHeader, { content: c.header }));
  assert.ok(header.includes("Header marker") && !header.includes(">UK data<"));
  const footer = html(createElement(MarketingFooter, { content: c.footer }));
  assert.ok(footer.includes("Footer marker tagline") && footer.includes("Footer link marker"));
  const search = html(createElement(SearchShowcase, { content: c.search.tabs }));
  assert.ok(search.includes("Search hint marker") && search.includes("Field marker A") && search.includes("Field marker B"));
  assert.ok(search.includes("Company search"), "tab labels not overridden stay as they were");
  const workflow = html(createElement(WorkflowShowcase, { content: c.workflow }));
  assert.ok(workflow.includes("Try marker") && workflow.includes("List title marker") && workflow.includes("Bullet marker"));
  assert.ok(workflow.includes("S one") && workflow.includes("S five") && !workflow.includes("Daily refresh"));
});

test("tab ids, order and ARIA wiring stay structural: they do not depend on content", () => {
  const c = clone<SiteContent>(DEFAULT_SITE_CONTENT);
  c.search.tabs.company.label = "Renamed";
  const markup = html(createElement(SearchShowcase, { content: c.search.tabs }));
  const tabs = [...markup.matchAll(/role="tab"[^>]*id="[^"]*-tab-([a-z]+)"[^>]*aria-selected="(true|false)"[^>]*aria-controls="[^"]*-panel"[^>]*tabindex="(-?\d)"/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(tabs, [["company", "true", "0"], ["filings", "false", "-1"], ["directors", "false", "-1"], ["sic", "false", "-1"]]);
  assert.ok(markup.includes('role="tabpanel"'));
});

test("repeated or numerous list items render without throwing or key collisions", () => {
  const c = clone<SiteContent>(DEFAULT_SITE_CONTENT);
  c.workflow.tabs.lists.bullets = ["Same", "Same", "Same"];
  c.search.tabs.company.fields = ["Dup", "Dup"];
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    html(createElement(WorkflowShowcase, { content: c.workflow }));
    html(createElement(SearchShowcase, { content: c.search.tabs }));
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, [], "React reported a warning (duplicate keys?)");
});
