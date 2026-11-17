import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { PROTECTED_FAQ } from "@/lib/site-content/protected-claims";
import { MAX_CONTENT_BYTES, applyEditable, parseEditableContent, toEditable, type EditableContent } from "@/lib/site-content/schema";
import { canonicalJson, contentHash } from "@/lib/site-content/canonical";
import { MAX_BODY_BYTES, isJsonContentType, isSameOrigin, readBoundedText, readMutationJson, requireSameOrigin } from "@/lib/site-content/request";
import { PERMISSIONS, resolvePermissions } from "@/lib/auth/permissions";

const base = (): EditableContent => JSON.parse(JSON.stringify(toEditable(DEFAULT_SITE_CONTENT)));
const issues = (input: unknown) => {
  const r = parseEditableContent(input);
  assert.equal(r.ok, false);
  return r.ok ? [] : r.issues;
};
// These tests write wrong or extra fields on purpose, so they work on a deliberately untyped view of the content.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Draft = any;
const mut = (fn: (c: Draft) => void) => {
  const c = base();
  fn(c);
  return c;
};

// ---- schema ---------------------------------------------------------------------------------------------------------

test("the built-in content, as editable content, validates and round-trips to exactly the built-in content", () => {
  const r = parseEditableContent(toEditable(DEFAULT_SITE_CONTENT));
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(applyEditable(DEFAULT_SITE_CONTENT, r.content), DEFAULT_SITE_CONTENT);
});

test("unknown fields are rejected at every level, so code-controlled content cannot be smuggled in", () => {
  for (const extra of [
    (c: Draft) => (c.stats = { total: 1 }),
    (c: Draft) => (c.api = { available: true }),
    (c: Draft) => (c.hero.apiNote = "API available now"),
    (c: Draft) => (c.hero.heading.href = "/x"),
    (c: Draft) => (c.header.links[0].href = "https://evil.example"),
    (c: Draft) => (c.footer.links[0].href = "/admin"),
    (c: Draft) => (c.faq.items[0].protected = false),
    (c: Draft) => (c.platform.cards[0].href = "/admin"),
    (c: Draft) => (c.platform.cards[0].icon = "Star"),
    (c: Draft) => (c.useCases.items[0].tone = "red"),
    (c: Draft) => (c.search.tabs.extra = { label: "x", hint: "y", fields: ["z"] }),
    (c: Draft) => (c.corporateStructure = { heading: "We hold ownership data" }),
  ]) {
    const found = issues(mut(extra));
    assert.ok(found.some((i) => /Unknown field/.test(i.message)), JSON.stringify(found));
  }
});

test("a missing field, a wrong type and a non-object are rejected", () => {
  assert.ok(issues(mut((c) => delete c.hero.intro)).length);
  assert.ok(issues(mut((c) => (c.hero.intro = 5))).length);
  for (const bad of [null, [], "x", 5, undefined]) assert.equal(parseEditableContent(bad).ok, false);
});

test("text must be plain: no markup characters, line breaks, control or bidirectional characters; it is trimmed and NFC-normalised", () => {
  for (const bad of ["<b>x</b>", "a < b", "x > y", "line\nbreak", "tab\there", "nul\u0000x", "zero​width", "rtl‮override", "bom﻿x"]) {
    assert.equal(parseEditableContent(mut((c) => (c.hero.intro = bad))).ok, false, JSON.stringify(bad));
  }
  const r = parseEditableContent(mut((c) => (c.hero.intro = "  Café data  ")));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.content.hero.intro, "Café data");
  assert.equal(parseEditableContent(mut((c) => (c.hero.intro = "   "))).ok, false, "empty after trimming");
});

test("length limits are enforced per field", () => {
  assert.equal(parseEditableContent(mut((c) => (c.hero.intro = "x".repeat(400)))).ok, true);
  assert.equal(parseEditableContent(mut((c) => (c.hero.intro = "x".repeat(401)))).ok, false);
  assert.equal(parseEditableContent(mut((c) => (c.faq.items[0].a = "x".repeat(1200)))).ok, true);
  assert.equal(parseEditableContent(mut((c) => (c.faq.items[0].a = "x".repeat(1201)))).ok, false);
  assert.equal(parseEditableContent(mut((c) => (c.header.links[0].label = "x".repeat(41)))).ok, false);
});

test("structural counts equal what the page's code supports", () => {
  assert.equal(parseEditableContent(mut((c) => c.platform.cards.pop())).ok, false);
  assert.equal(parseEditableContent(mut((c) => c.platform.cards.push({ title: "Extra", text: "card" }))).ok, false);
  assert.equal(parseEditableContent(mut((c) => c.apart.items.pop())).ok, false);
  assert.equal(parseEditableContent(mut((c) => c.useCases.items.pop())).ok, false);
  assert.equal(parseEditableContent(mut((c) => c.workflow.steps.pop())).ok, false);
  assert.equal(parseEditableContent(mut((c) => c.header.links.pop())).ok, false);
  assert.equal(parseEditableContent(mut((c) => c.footer.links.push({ label: "More" }))).ok, false);
  assert.equal(parseEditableContent(mut((c) => (c.builtFor.audiences = ["One", "Two"]))).ok, false, "marquee needs at least three labels");
  assert.equal(parseEditableContent(mut((c) => (c.builtFor.audiences = Array.from({ length: 9 }, (_, i) => `A${i}`)))).ok, false);
  assert.equal(parseEditableContent(mut((c) => (c.search.tabs.company.fields = []))).ok, false);
  assert.equal(parseEditableContent(mut((c) => (c.workflow.tabs.lists.bullets = Array.from({ length: 7 }, (_, i) => `B${i}`)))).ok, false);
  assert.equal(parseEditableContent(mut((c) => (c.faq.items = []))).ok, false);
  assert.equal(parseEditableContent(mut((c) => (c.faq.items = Array.from({ length: 9 }, (_, i) => ({ q: `Q${i}?`, a: "A" }))))).ok, false);
});

test("an editable FAQ question may not repeat a protected one (that would put a second answer beside the protected claim)", () => {
  for (const q of [PROTECTED_FAQ.ownership.q, PROTECTED_FAQ.updated.q]) {
    const found = issues(mut((c) => c.faq.items.push({ q, a: "Yes, available now." })));
    assert.ok(found.some((i) => /protected/.test(i.message)), q);
  }
  assert.equal(parseEditableContent(mut((c) => c.faq.items.push({ q: "Do you offer training?", a: "Not currently." }))).ok, true);
});

test("oversized content is refused with a size message before any field is examined", () => {
  const huge = mut((c) => (c.faq.items[0].a = "x".repeat(MAX_CONTENT_BYTES)));
  const found = issues(huge);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /too large/);
  assert.equal(parseEditableContent({ a: "x".repeat(MAX_CONTENT_BYTES + 1) }).ok, false);
});

test("the largest content the field limits allow still fits under the size cap", () => {
  const c = base();
  const fill = (o: unknown): unknown => {
    if (typeof o === "string") return "x".repeat(Math.min(400, 1200));
    if (Array.isArray(o)) return o.map(fill);
    if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v)]));
    return o;
  };
  // Every field at a generous 400 characters is far beyond real use; the per-field caps are what actually bound the object.
  const r = parseEditableContent(fill(c));
  assert.equal(r.ok === false && r.issues.some((i) => /too large/.test(i.message)), false);
});

test("applyEditable never lets stored content change link destinations: hrefs come from the built-ins by position", () => {
  const c = mut((x) => {
    x.header.links[0].label = "Renamed";
    x.footer.links[2].label = "Also renamed";
  });
  const r = parseEditableContent(c);
  assert.ok(r.ok);
  if (!r.ok) return;
  const site = applyEditable(DEFAULT_SITE_CONTENT, r.content);
  assert.deepEqual(site.header.links.map((l) => l.href), DEFAULT_SITE_CONTENT.header.links.map((l) => l.href));
  assert.deepEqual(site.footer.links.map((l) => l.href), DEFAULT_SITE_CONTENT.footer.links.map((l) => l.href));
  assert.equal(site.header.links[0].label, "Renamed");
  assert.equal(site.footer.links[2].label, "Also renamed");
});

// ---- canonical JSON and hashes --------------------------------------------------------------------------------------

test("canonical JSON is independent of key order and the hash identifies the content", () => {
  const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: "z" } };
  const b = { a: { c: "z", d: [3, { x: 2, y: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"c":"z","d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(contentHash(a), contentHash(b));
  assert.match(contentHash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(contentHash(a), contentHash({ ...a, b: 2 }));
  assert.notEqual(contentHash([1, 2]), contentHash([2, 1]), "array order is significant");
});

test("canonical JSON refuses values that are not JSON", () => {
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: NaN }));
  assert.throws(() => canonicalJson({ a: () => 1 }));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic));
});

test("the hash of the default content is stable (guards against accidental changes to canonicalisation)", () => {
  assert.equal(contentHash(base()), contentHash(JSON.parse(JSON.stringify(base()))));
});

// ---- request hygiene ------------------------------------------------------------------------------------------------

const req = (headers: Record<string, string>, body?: BodyInit | null, method = "POST") =>
  new Request("http://localhost:3000/api/admin/website-content/draft", { method, headers, body, ...(body ? ({ duplex: "half" } as object) : {}) });

test("same-origin check: Origin must be present and match Host; forwarded host only when TRUST_PROXY=1", () => {
  assert.equal(isSameOrigin(req({ host: "app.example", origin: "https://app.example" })), true);
  assert.equal(isSameOrigin(req({ host: "app.example", origin: "https://evil.example" })), false);
  assert.equal(isSameOrigin(req({ host: "app.example" })), false, "missing Origin");
  assert.equal(isSameOrigin(req({ host: "app.example", origin: "null" })), false);
  assert.equal(isSameOrigin(req({ host: "app.example", origin: "not a url" })), false);
  assert.equal(isSameOrigin(req({ host: "app.example:3000", origin: "http://app.example" })), false, "port must match");
  const previous = process.env.TRUST_PROXY;
  try {
    process.env.TRUST_PROXY = "";
    assert.equal(isSameOrigin(req({ host: "internal:3000", origin: "https://public.example", "x-forwarded-host": "public.example" })), false);
    process.env.TRUST_PROXY = "1";
    assert.equal(isSameOrigin(req({ host: "internal:3000", origin: "https://public.example", "x-forwarded-host": "public.example" })), true);
    assert.equal(isSameOrigin(req({ host: "internal:3000", origin: "https://evil.example", "x-forwarded-host": "public.example" })), false);
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previous;
  }
  assert.equal(requireSameOrigin(req({ host: "a", origin: "http://b" }))?.status, 403);
  assert.equal(requireSameOrigin(req({ host: "a", origin: "http://a" })), null);
});

test("content type must be exactly application/json (parameters allowed)", () => {
  assert.equal(isJsonContentType(req({ "content-type": "application/json" })), true);
  assert.equal(isJsonContentType(req({ "content-type": "application/json; charset=utf-8" })), true);
  for (const t of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", ""]) assert.equal(isJsonContentType(req(t ? { "content-type": t } : {})), false, t);
});

test("the body is read with a hard cap, without trusting Content-Length, and only then parsed", async () => {
  const big = "x".repeat(MAX_BODY_BYTES + 10);
  const tooBigDeclared = await readBoundedText(req({ "content-type": "application/json", "content-length": String(big.length) }, big));
  assert.equal(tooBigDeclared.ok === false && tooBigDeclared.response.status, 413);

  // A stream that lies by not declaring a length: it is cut off at the cap.
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = new Uint8Array(16 * 1024).fill(97);
      sent += chunk.length;
      controller.enqueue(chunk);
      if (sent > MAX_BODY_BYTES * 4) controller.close();
    },
  });
  const streamed = await readBoundedText(req({ "content-type": "application/json" }, stream));
  assert.equal(streamed.ok === false && streamed.response.status, 413);
  assert.ok(sent < MAX_BODY_BYTES * 4, "reading stopped early instead of buffering everything");

  const ok = await readBoundedText(req({ "content-type": "application/json" }, '{"a":1}'));
  assert.equal(ok.ok && ok.text, '{"a":1}');
});

test("mutation JSON: wrong origin, wrong type, oversized and malformed bodies are refused with the right status", async () => {
  const good = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
  const r = await readMutationJson(req(good, '{"a":1}'));
  assert.deepEqual(r.ok && r.json, { a: 1 });
  const status = async (headers: Record<string, string>, body: string) => {
    const x = await readMutationJson(req(headers, body));
    return x.ok ? 200 : x.response.status;
  };
  assert.equal(await status({ ...good, origin: "http://evil.example" }, "{}"), 403);
  assert.equal(await status({ host: good.host, "content-type": "application/json" }, "{}"), 403);
  assert.equal(await status({ ...good, "content-type": "text/plain" }, "{}"), 415);
  assert.equal(await status(good, "{not json"), 400);
  assert.equal(await status(good, JSON.stringify({ a: "x".repeat(MAX_BODY_BYTES) })), 413);
});

// ---- authorisation model --------------------------------------------------------------------------------------------

test("no CMS permission key exists, so nothing can leak to legacy ADMIN accounts through the permission catalogue", () => {
  const keys: string[] = PERMISSIONS.map((p) => p.key);
  assert.ok(!keys.some((k) => /cms|content|website|site/i.test(k)), keys.join(","));
  assert.equal(keys.length, 20, "the catalogue is unchanged (20 keys); adding one is a deliberate act that must revisit this test");
  for (const role of ["USER", "ADMIN"] as const) {
    assert.ok(!resolvePermissions(role, null).some((k) => /cms|content|website|site/i.test(k)));
  }
});
