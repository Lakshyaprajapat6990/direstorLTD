import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { parseEditableContent, toEditable, type EditableContent } from "@/lib/site-content/schema";
import { describePath, duplicateSection, getIn, insertAt, isRichPath, listBounds, move, newBlock, newId, newSection, parsePath, pruneEmptyOptionals, removeAt, removeKey, setIn } from "@/lib/site-content/editor-model";

const base = (): EditableContent => JSON.parse(JSON.stringify(toEditable(DEFAULT_SITE_CONTENT)));
const withCustom = (): EditableContent => {
  const c = base();
  c.custom = [newSection({ type: "text" }, "beforeFaq"), newSection({ type: "cta" }, "afterHero"), newSection({ type: "faq" }, "beforeFaq"), newSection({ type: "cards" }, "beforeFaq")];
  return c;
};

test("reading and writing by path never mutates the original", () => {
  const c = base();
  const before = JSON.stringify(c);
  const next = setIn(c, ["hero", "heading", "lead"], "Changed lead");
  assert.equal(JSON.stringify(c), before);
  assert.equal(next.hero.heading.lead, "Changed lead");
  assert.equal(next.hero.intro, c.hero.intro, "everything else is shared, not rebuilt");
  const arr = setIn(c, ["builtFor", "audiences", 1], "Renamed");
  assert.equal(arr.builtFor.audiences[1], "Renamed");
  assert.equal(c.builtFor.audiences[1], "Formation agents");
  assert.equal(getIn(c, parsePath("platform.cards.2.title")), "Saved reports");
  assert.equal(getIn(c, parsePath("platform.cards.99.title")), undefined);
  assert.equal(getIn(c, ["nope", "deeper"]), undefined);
});

test("removing an optional key removes only that key", () => {
  const c = withCustom();
  const next = removeKey(c, ["custom", 0, "title"]);
  assert.equal("title" in next.custom[0], false);
  assert.equal(next.custom[0].type, "text");
  assert.equal("title" in c.custom[0], true);
});

test("list helpers insert, remove and move without touching the source list", () => {
  const l = ["a", "b", "c"];
  assert.deepEqual(insertAt(l, 1, "x"), ["a", "x", "b", "c"]);
  assert.deepEqual(removeAt(l, 1), ["a", "c"]);
  assert.deepEqual(move(l, 0, 2), ["b", "c", "a"]);
  assert.deepEqual(move(l, 2, 0), ["c", "a", "b"]);
  assert.deepEqual(move(l, 1, 5), ["a", "b", "c"], "out of range: unchanged");
  assert.deepEqual(move(l, 1, -1), ["a", "b", "c"]);
  assert.deepEqual(l, ["a", "b", "c"]);
});

test("every kind of clicked element is described correctly", () => {
  const c = withCustom();
  assert.deepEqual(describePath(c, "hero.heading"), { kind: "headingParts", label: "Heading", heading: { builtin: "hero.heading" } });
  assert.equal(describePath(c, "hero.intro").kind, "rich");
  assert.equal(describePath(c, "faq.items.0.a").kind, "rich");
  assert.equal(describePath(c, "faq.items.0.q").kind, "plain");
  assert.deepEqual(describePath(c, "hero.primaryCtaLabel"), { kind: "button", button: "hero.primary" }, "a button label opens the button settings");
  assert.equal(describePath(c, "platform.cards.1.text").kind, "rich");
  assert.equal(describePath(c, "platform.cards.1.title").kind, "plain");
  assert.deepEqual(describePath(c, "custom.0"), { kind: "section", index: 0 });
  assert.deepEqual(describePath(c, "custom.0.blocks.0"), { kind: "block", section: 0, block: 0 });
  assert.equal(describePath(c, "custom.0.title").kind, "plain");
  assert.equal(describePath(c, "custom.1.text").kind, "rich");
  assert.equal(describePath(c, "custom.3.cards.0.text").kind, "rich");
  assert.equal(describePath(c, "custom.2.items.0.a").kind, "rich");
  assert.equal(describePath(c, "no.such.path").kind, "none");
  assert.equal(describePath(c, "custom.9").kind, "none");
  const aud = describePath(c, "builtFor.audiences.2");
  assert.equal(aud.kind, "plain");
  if (aud.kind === "plain") {
    assert.equal(aud.max, 40);
    assert.deepEqual(aud.list, { path: ["builtFor", "audiences"], index: 2, min: 3, max: 8 });
  }
  const fixedList = describePath(c, "workflow.steps.1");
  assert.equal(fixedList.kind === "plain" && fixedList.list?.max, 0, "steps cannot change length");
});

test("paragraph fields use their own length limits", () => {
  const c = base();
  const d = describePath(c, "faq.items.0.a");
  assert.ok(d.kind === "rich" && d.max === 1200);
  const e = describePath(c, "hero.intro");
  assert.ok(e.kind === "rich" && e.max === 400);
});

test("which fields are rich is decided by path, and only for paragraph-like fields", () => {
  for (const p of ["hero.intro", "workflow.tabs.lists.text", "custom.3.cards.2.text", "custom.0.intro", "faq.items.4.a"]) assert.ok(isRichPath(p), p);
  for (const p of ["hero.primaryCtaLabel", "faq.heading", "platform.cards.0.title", "header.links.0.label", "custom.0.title", "builtFor.audiences.1"]) assert.ok(!isRichPath(p), p);
});

test("which lists may change length, and how far", () => {
  assert.deepEqual(listBounds(["builtFor", "audiences"]), [3, 8]);
  assert.deepEqual(listBounds(["search", "tabs", "company", "fields"]), [1, 8]);
  assert.deepEqual(listBounds(["workflow", "tabs", "lists", "bullets"]), [1, 6]);
  assert.deepEqual(listBounds(["faq", "items"]), [1, 8]);
  assert.deepEqual(listBounds(["custom", 2, "cards"]), [1, 6]);
  assert.deepEqual(listBounds(["custom", 2, "items"]), [1, 8]);
  assert.deepEqual(listBounds(["custom", 0, "blocks"]), [1, 12]);
  for (const fixed of [["platform", "cards"], ["apart", "items"], ["useCases", "items"], ["workflow", "steps"], ["header", "links"], ["footer", "links"]]) assert.equal(listBounds(fixed), null, fixed.join("."));
});

test("new sections get unique, valid ids", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, /^[a-z0-9]{6,24}$/);
});

test("a duplicated section is a deep, independent copy with its own id", () => {
  const c = withCustom();
  const copy = duplicateSection(c.custom[0]);
  assert.notEqual(copy.id, c.custom[0].id);
  assert.deepEqual({ ...copy, id: "x" }, { ...c.custom[0], id: "x" });
  if (copy.type === "text" && c.custom[0].type === "text") {
    copy.blocks[0] = { kind: "p", runs: [{ text: "changed" }] };
    assert.notDeepEqual(copy.blocks, c.custom[0].blocks);
  }
});

test("starter blocks are valid inside a text section", () => {
  const c = withCustom();
  for (const kind of ["p", "h2", "h3", "ul", "ol"] as const) {
    const s = c.custom[0];
    assert.equal(s.type, "text");
    if (s.type === "text") s.blocks.push(newBlock(kind));
  }
  assert.ok(parseEditableContent(c).ok);
});

test("empty optional text is dropped before saving so the server never sees an empty value", () => {
  const c = withCustom();
  const t = c.custom[0];
  if (t.type === "text") t.title = "   ";
  const cta = c.custom[1];
  if (cta.type === "cta") cta.text = { runs: [{ text: "  " }] };
  const cards = c.custom[3];
  if (cards.type === "cards") {
    cards.heading = "";
    cards.intro = "";
  }
  const pruned = pruneEmptyOptionals(c);
  assert.equal("title" in pruned.custom[0], false);
  assert.equal("text" in pruned.custom[1], false);
  assert.equal("heading" in pruned.custom[3] || "intro" in pruned.custom[3], false);
  assert.ok(parseEditableContent(pruned).ok);
  assert.equal(parseEditableContent(c).ok, false, "unpruned, the same content is refused");
  // required text is never dropped
  const keep = pruneEmptyOptionals(withCustom());
  assert.equal("heading" in keep.custom[1], true);
});
