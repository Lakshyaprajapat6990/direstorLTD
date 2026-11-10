import { test } from "node:test";
import { embedUrl } from "../../src/lib/site-content/sections";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HomeView } from "@/components/marketing/HomeView";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { applyEditable, mediaIdsIn, parseEditableContent, toEditable, type EditableContent } from "@/lib/site-content/schema";
import { describePath, getCardImage, newButtonBlock, newSection, newVideoBlock, patchStyle, setCardImage } from "@/lib/site-content/editor-model";
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
const M1 = "a".repeat(32);
const M2 = "b".repeat(32);

// ---- individual figure cards -------------------------------------------------------------------------------------------------------------

test("a look set for one figure card applies to that card only, over the shared look; the figures stay live", () => {
  let e = base();
  e = patchStyle(e, "cards", "dissolved", { bg: "#FFF7E6", radius: 30, valueColor: "#B45309", valueItalic: true, labelSize: 14, labelWeight: "bold", labelItalic: true });
  const html = page(ok(e));
  const cards = [...html.matchAll(/<div class="min-w-0 rounded-xl border border-slate-200 bg-white px-4 py-4"([^>]*)>/g)].map((m) => m[1]);
  assert.equal(cards.length, 6);
  assert.equal(cards.filter((c) => /style=/.test(c)).length, 1, "exactly one card is styled");
  assert.match(cards[2], /background-color:#fff7e6;border-radius:30px/);
  assert.match(html, /style="color:#b45309;font-style:italic"><span class="sr-only">10<\/span>/, "its own figure, still 10");
  assert.match(html, /style="font-size:0\.875rem;font-weight:700;font-style:italic"[^>]*>Dissolved<\/p>/);
  for (const n of ["40", "25", "6"]) assert.match(html, new RegExp(`<span class="sr-only">${n}</span>`));
  // the shared look is the base; a card's own settings win
  const sh = patchStyle(e, "texts", "x.y", {});
  const both = { ...sh, styles: { ...sh.styles, statCards: { radius: 8, bg: "#112233" }, cards: { dissolved: { radius: 30 } } } } as EditableContent;
  const h2 = page(ok(both));
  assert.equal((h2.match(/background-color:#112233/g) ?? []).length, 6);
  assert.equal((h2.match(/border-radius:30px/g) ?? []).length, 1);
  assert.equal((h2.match(/border-radius:8px/g) ?? []).length, 5);
});

test("the large register card has its own look; a chosen colour replaces its gradient; its number stays live", () => {
  const e = patchStyle(base(), "cards", "register", { bg: "#EEF2FF", radius: 12, valueColor: "#B45309", padX: 40 });
  const html = page(ok(e));
  assert.match(html, /<div class="min-w-0 rounded-3xl[^"]*" style="[^"]*background:#eef2ff/);
  assert.match(html, /style="color:#b45309"><span class="sr-only">40<\/span>/);
  assert.equal(page(base()), page({ ...base(), styles: undefined } as EditableContent));
  const editing = page(base(), true);
  for (const k of ["total", "active", "dissolved", "directors", "filters", "sync"]) assert.match(editing, new RegExp(`data-cms="card:stat\\.${k}"`));
  assert.match(editing, /data-cms="card:register"[^>]*|data-cms-locked="[^"]*"[^>]*data-cms="card:register"/);
});

test("card look keys are the seven cards only, and values are the bounded look", () => {
  const st = (v: unknown) => ({ ...base(), styles: { cards: v } });
  ok(st({ total: { bg: "#ffffff" }, register: { radius: 20, labelSize: 12 } }));
  bad(st({ nope: { bg: "#ffffff" } }), /Unknown/);
  bad(st({ total: { bg: "white" } }), /six-digit/);
  bad(st({ total: { labelSize: 99 } }), /At most/);
  bad(st({ total: { figure: "1" } }), /Unknown/);
  assert.equal("styles" in ok(st({ total: {} })), false);
});

// ---- picture slots ------------------------------------------------------------------------------------------------------------------------

test("the decorative circles and the use-case headers can hold a picture; without one the design is unchanged", () => {
  const plain = page(base());
  assert.match(plain, /aria-hidden="true"><span class="absolute h-32 w-32 rounded-full/);
  let e = setCardImage(base(), { type: "circle", index: 1 }, { mediaId: M1, alt: "Team" });
  e = setCardImage(e, { type: "useCase", index: 0 }, { mediaId: M2, alt: "Accountants at work", fit: "contain" });
  const out = ok(e);
  const html = page(out);
  assert.match(html, new RegExp(`<img src="/media/${M1}" alt="Team" loading="lazy" decoding="async" class="h-full w-full rounded-full object-cover"/>`));
  assert.match(html, new RegExp(`<img src="/media/${M2}" alt="Accountants at work"[^>]*class="absolute inset-0 h-full w-full object-contain"`));
  assert.ok(!/aria-hidden="true"><span class="absolute h-32/.test(html), "a picture is not hidden from assistive technology");
  assert.equal((html.match(/rounded-full sm:h-44 sm:w-44 border-4 border-white bg-gradient-to-br from-indigo-100\/70 to-white shadow-lg/g) ?? []).length, 3, "the circles keep their shape classes");
  assert.deepEqual(mediaIdsIn(out).sort(), [M1, M2], "pictures in slots count as used media");
  assert.deepEqual(getCardImage(out, { type: "circle", index: 1 }), { mediaId: M1, alt: "Team" });
  assert.deepEqual(setCardImage(out, { type: "circle", index: 1 }, undefined).apart.circles, undefined, "removing the last one removes the container");
  assert.equal("image" in setCardImage(out, { type: "useCase", index: 0 }, undefined).useCases.items[0], false);
  assert.match(page(e, true), /data-cms="image:circle\.0"[^>]*>/);
  assert.match(page(e, true), /data-cms="image:useCase\.2"/);
  assert.deepEqual(describePath(out, "image:circle.2"), { kind: "cardImage", target: { type: "circle", index: 2 } });
  assert.equal(describePath(out, "image:circle.3").kind, "none");
  assert.equal(describePath(out, "image:useCase.9").kind, "none");
});

test("picture slot values are validated: media id, alt text, fit", () => {
  const withCircle = (v: unknown) => ({ ...base(), apart: { ...base().apart, circles: v } });
  ok(withCircle({ "0": { mediaId: M1, alt: "x" } }));
  bad(withCircle({ "3": { mediaId: M1, alt: "x" } }), /Unknown/);
  bad(withCircle({ "0": { mediaId: "../x", alt: "x" } }), /Choose an image/);
  bad(withCircle({ "0": { mediaId: M1, alt: "" } }), /empty/i);
  bad(withCircle({ "0": { mediaId: M1, alt: "x", fit: "stretch" } }));
  bad(withCircle({ "0": { mediaId: M1, alt: "x", src: "http://evil" } }), /Unknown/);
  const uc = base();
  (uc.useCases.items[1] as { image?: unknown }).image = { mediaId: "z", alt: "x" };
  bad(uc, /Choose an image/);
});

// ---- more block types in a text section --------------------------------------------------------------------------------------------------

test("a text section can hold a button and a video; destinations and video addresses are validated", () => {
  const section = (blocks: unknown[]) => ({ ...base(), custom: [{ id: "textsection01", slot: "beforeFaq", type: "text", blocks }] });
  const e = ok(section([newButtonBlock(), newVideoBlock({ provider: "youtube", videoId: "dQw4w9WgXcQ" }), { kind: "p", runs: [{ text: "Words" }] }]));
  const html = page(e);
  assert.match(html, /<a [^>]*href="#uk-data"[^>]*>Learn more<\/a>/);
  // The player itself is held behind the cookie-consent gate (a placeholder in server HTML); its address is still built from validated parts.
  assert.ok(!/<iframe/.test(html));
  assert.match(html, /This video is hosted by YouTube, which may set cookies/);
  assert.equal(embedUrl("youtube", "dQw4w9WgXcQ"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  const ext = ok(section([{ kind: "button", label: "Offer", href: "https://example.com/x", settings: { newTab: true, bg: "#123456", align: "center" } }]));
  const h2 = page(ext);
  assert.match(h2, /<a style="background-color:#123456"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*href="https:\/\/example\.com\/x"/);
  assert.match(h2, /<div class="flex" style="justify-content:center">/);
  for (const href of ["javascript:alert(1)", "http://example.com", "//evil.example", "data:text/html,x", "/admin", ""]) bad(section([{ kind: "button", label: "x", href }]));
  bad(section([{ kind: "button", label: "x", href: "/login", settings: { href: "https://evil.example" } }]), /Unknown/);
  bad(section([{ kind: "video", provider: "youtube", videoId: "short", title: "t" }]), /valid video id/);
  bad(section([{ kind: "video", provider: "youtube", videoId: "dQw4w9WgXcQ", title: "t", src: "https://evil.example" }]), /Unknown/);
  bad(section([{ kind: "video", provider: "dailymotion", videoId: "dQw4w9WgXcQ", title: "t" }]));
  assert.ok(!/<script/.test(h2));
});

test("every section type the dialog offers starts valid, so it can be saved at once", () => {
  for (const input of [{ type: "text" }, { type: "cta" }, { type: "cards" }, { type: "faq" }, { type: "image", mediaId: M1, alt: "x", width: 10, height: 10 }, { type: "video", provider: "youtube", videoId: "dQw4w9WgXcQ" }] as const) {
    const c = base();
    c.custom = [newSection(input, "beforeFaq")];
    ok(c);
  }
});
