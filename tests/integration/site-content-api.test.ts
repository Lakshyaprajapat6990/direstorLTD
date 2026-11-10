import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, db, login, sessionFor, createUser, STRONG_PASSWORD, type Session } from "./helpers";
import { ALL_PERMISSION_KEYS } from "../../src/lib/auth/permissions";
import { contentHash } from "../../src/lib/site-content/canonical";
import { getPublishedSiteContentResolved } from "../../src/lib/site-content/reader";
import { getRegisterBreakdown } from "../../src/lib/data/companies";
import { getPublicSiteStats } from "../../src/lib/data/public-stats";
import { afterCommit } from "../../src/lib/site-content/route-helpers";
import { publish, rollback, saveDraft, getState } from "../../src/lib/site-content/store";
import { DEFAULT_SITE_CONTENT } from "../../src/lib/site-content/defaults";
import { toEditable, type EditableContent } from "../../src/lib/site-content/schema";

after(async () => {
  await db.$disconnect();
});

// Real PostgreSQL + the production build, scratch resources only (helpers.ts refuses anything else). The API works on the
// single "home" document, so the API tests below form one ordered scenario and always read the current versions first.

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const defaults = (): EditableContent => clone(toEditable(DEFAULT_SITE_CONTENT));
const marker = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;
const withIntro = (intro: string): EditableContent => {
  const c = defaults();
  c.hero.intro = intro;
  return c;
};

interface Res {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Headers;
}
async function cms(s: Session | null, path: string, method: string, body?: unknown, extra: { headers?: Record<string, string>; raw?: string; noOrigin?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(extra.noOrigin ? {} : { origin: BASE }), ...(s ? { cookie: `director_session=${s.cookie}` } : {}), ...(body !== undefined || extra.raw !== undefined ? { "content-type": "application/json" } : {}), ...extra.headers };
  const res = await fetch(`${BASE}${path}`, { method, headers, body: extra.raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: "manual" });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, headers: res.headers };
}
const state = async (s: Session) => (await cms(s, "/api/admin/website-content", "GET")).json.state;
const saveD = (s: Session, content: unknown, expectedDraftVersion: number, extra: Record<string, unknown> = {}) => cms(s, "/api/admin/website-content/draft", "PUT", { content, expectedDraftVersion, ...extra });
const publishD = (s: Session, expectedDraftVersion: number, expectedPublishedVersion: number, note?: string) => cms(s, "/api/admin/website-content/publish", "POST", { expectedDraftVersion, expectedPublishedVersion, ...(note !== undefined ? { note } : {}) });
const rollbackD = (s: Session, toVersion: number, expectedPublishedVersion: number) => cms(s, "/api/admin/website-content/rollback", "POST", { toVersion, expectedPublishedVersion });

async function pageRes(s: Session | null, p: string) {
  const res = await fetch(`${BASE}${p}`, { headers: s ? { cookie: `director_session=${s.cookie}` } : {}, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), headers: res.headers, text: await res.text() };
}

async function publicHtmlHas(text: string, ms = 40_000): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const html = await (await fetch(`${BASE}/`)).text();
    if (html.includes(text)) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

const ROUTES: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: "/api/admin/website-content" },
  { method: "PUT", path: "/api/admin/website-content/draft", body: { content: defaults(), expectedDraftVersion: 0 } },
  { method: "POST", path: "/api/admin/website-content/publish", body: { expectedDraftVersion: 0, expectedPublishedVersion: 0 } },
  { method: "POST", path: "/api/admin/website-content/rollback", body: { toVersion: 1, expectedPublishedVersion: 0 } },
];

// ---- authorization ----------------------------------------------------------------------------------------------------------

test("every Website Content API refuses everyone but a Super Admin, before reading the request: anonymous 401; user, legacy admin and fully-permissioned admin 403", async () => {
  const user = await sessionFor("USER", "cmsauth");
  const legacyAdmin = await sessionFor("ADMIN", "cmsauth"); // permissions NULL = the legacy ADMIN default (every catalogue key)
  const adminUser = await createUser("ADMIN", "cmsfull");
  await db.user.update({ where: { id: adminUser.id }, data: { permissions: JSON.stringify(ALL_PERMISSION_KEYS) } });
  const fullAdmin = { cookie: (await login(adminUser.email, STRONG_PASSWORD)).cookie!, userId: adminUser.id, email: adminUser.email };
  const sa = await sessionFor("SUPER_ADMIN", "cmsauth");

  for (const r of ROUTES) {
    assert.equal((await cms(null, r.path, r.method, r.body)).status, 401, `anonymous ${r.method} ${r.path}`);
    for (const [who, s] of [["user", user], ["legacy admin", legacyAdmin], ["admin with every permission", fullAdmin]] as const) {
      assert.equal((await cms(s, r.path, r.method, r.body)).status, 403, `${who} ${r.method} ${r.path}`);
      // The guard runs before the body is looked at: even a hostile body and a wrong origin learn nothing but "403".
      if (r.method !== "GET") {
        assert.equal((await cms(s, r.path, r.method, undefined, { raw: "{not json", noOrigin: true, headers: { "content-type": "text/plain" } })).status, 403, `${who} ${r.method} ${r.path} (bad request)`);
      }
    }
    // The Super Admin gets past authorization. Mutations are probed with an empty body (a 400) so nothing is written.
    const asSa = await cms(sa, r.path, r.method, r.method === "GET" ? undefined : {});
    assert.equal(asSa.status, r.method === "GET" ? 200 : 400, `Super Admin ${r.method} ${r.path}`);
  }
  // Nothing was written by the refused attempts.
  assert.equal((await db.siteContent.findUnique({ where: { key: "home" } }))?.draftVersion ?? 0, 0);
});

test("a deactivated Super Admin and a signed-out session lose access immediately", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "cmsoff");
  assert.equal((await cms(sa, "/api/admin/website-content", "GET")).status, 200);
  await db.user.update({ where: { id: sa.userId }, data: { active: false } });
  assert.equal((await cms(sa, "/api/admin/website-content", "GET")).status, 401);
});

test("pages: Super Admin sees the screen; anonymous is sent to sign in; user and admin are sent away; the preview behaves the same and is never cached or indexed", async () => {
  const user = await sessionFor("USER", "cmspg");
  const admin = await sessionFor("ADMIN", "cmspg");
  const sa = await sessionFor("SUPER_ADMIN", "cmspg");

  for (const p of ["/admin/website-content", "/website-preview"]) {
    const anon = await pageRes(null, p);
    assert.ok([302, 303, 307, 308].includes(anon.status), `${p} anonymous status ${anon.status}`);
    assert.match(anon.location ?? "", /login|api\/auth\/expired/, p);
    for (const s of [user, admin]) {
      const r = await pageRes(s, p);
      assert.ok([302, 303, 307, 308].includes(r.status), `${p} status ${r.status}`);
      assert.match(r.location ?? "", /dashboard/, p);
      assert.ok(!r.text.includes("Website content"), "no content leaks in the redirect body");
    }
  }
  const screen = await pageRes(sa, "/admin/website-content");
  assert.equal(screen.status, 200);
  assert.match(screen.text, /Website Content/);
  assert.match(screen.text, /Save draft/);

  const preview = await pageRes(sa, "/website-preview");
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Preview, not public/);
  assert.match(preview.headers.get("cache-control") ?? "", /no-store|no-cache|private/);
  assert.match(preview.text, /<meta name="robots" content="[^"]*noindex/);
});

test("the Super Admin tab order is intact with Website Content last; staff/admin users never see it; the main navigation has no entry", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "cmstab");
  const html = (await pageRes(sa, "/admin")).text;
  const order = ["Overview", "Column &amp; Default Settings", "Website Content"].map((l) => html.indexOf(l));
  assert.ok(order.every((i) => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const start = html.indexOf('<nav aria-label="Primary"');
  assert.ok(start >= 0, "the primary navigation is present");
  const primary = html.slice(start, html.indexOf("</nav>", start));
  assert.ok(primary.includes("Super Admin") && !primary.includes("Website Content"), "Website Content is not a primary navigation entry");

  const admin = await sessionFor("ADMIN", "cmstab"); // legacy admin: has staff.view etc.
  const staffPage = await pageRes(admin, "/admin/staff");
  assert.equal(staffPage.status, 200);
  assert.ok(!staffPage.text.includes("Website Content"), "supervisors do not see the tab");
  for (const tab of ["Staff", "Activity &amp; reports", "Timesheets"]) assert.ok(staffPage.text.includes(tab), `existing tab ${tab} still there for supervisors`);
});

// ---- request hygiene --------------------------------------------------------------------------------------------------------

test("mutations refuse a missing or foreign Origin, a wrong content type, malformed JSON, an oversized body and unknown fields", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "cmshyg");
  const url = "/api/admin/website-content/draft";
  assert.equal((await cms(sa, url, "PUT", { content: defaults(), expectedDraftVersion: 0 }, { noOrigin: true })).status, 403);
  assert.equal((await cms(sa, url, "PUT", { content: defaults(), expectedDraftVersion: 0 }, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await cms(sa, url, "PUT", undefined, { raw: JSON.stringify({ content: defaults(), expectedDraftVersion: 0 }), headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await cms(sa, url, "PUT", undefined, { raw: "{broken" })).status, 400);
  const huge = await cms(sa, url, "PUT", undefined, { raw: JSON.stringify({ content: defaults(), expectedDraftVersion: 0, pad: "x".repeat(200_000) }) });
  assert.equal(huge.status, 413);
  assert.equal((await cms(sa, url, "PUT", { content: defaults(), expectedDraftVersion: 0, extra: true })).status, 400, "unknown request field");
  assert.equal((await cms(sa, url, "PUT", { content: defaults(), expectedDraftVersion: -1 })).status, 400);
  assert.equal((await cms(sa, url, "PUT", { content: defaults(), expectedDraftVersion: "0" })).status, 400);
  assert.equal((await cms(sa, "/api/admin/website-content/publish", "POST", { expectedDraftVersion: 0, expectedPublishedVersion: 0, note: "<b>x</b>" })).status, 400);
  assert.equal((await cms(sa, "/api/admin/website-content/publish", "POST", { expectedDraftVersion: 0, expectedPublishedVersion: 0, note: "n".repeat(201) })).status, 400);
  assert.equal((await db.siteContent.findUnique({ where: { key: "home" } }))?.draftVersion ?? 0, 0, "none of that saved anything");
});

test("content validation over the API: protected claims, unknown fields, markup and counts are rejected with located messages", async () => {
  const sa = await sessionFor("SUPER_ADMIN", "cmsval");
  const bad = async (mutate: (c: any) => void, expectPath: RegExp, expectMsg?: RegExp) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const c = defaults();
    mutate(c);
    const r = await saveD(sa, c, 0);
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.code, "invalid_content");
    assert.ok(r.json.issues.some((i: { path: string; message: string }) => expectPath.test(i.path) || expectPath.test(i.message)), JSON.stringify(r.json.issues));
    if (expectMsg) assert.ok(r.json.issues.some((i: { message: string }) => expectMsg.test(i.message)));
  };
  await bad((c) => (c.stats = { total: 1 }), /stats/, /Unknown field/);
  await bad((c) => (c.api = { available: true }), /api/);
  await bad((c) => (c.hero.heading.accent = "<img src=x onerror=alert(1)>"), /hero\.heading\.accent/);
  await bad((c) => c.faq.items.push({ q: "Do you hold ownership or corporate hierarchy data?", a: "Yes, available now." }), /faq/, /protected/);
  await bad((c) => (c.header.links[0].href = "https://evil.example"), /header\.links\.0/, /Unknown field/);
  await bad((c) => c.platform.cards.push({ title: "Extra", text: "card" }), /platform\.cards/);
  await bad((c) => (c.hero.intro = "x".repeat(401)), /hero\.intro/);
  assert.equal((await db.siteContent.findUnique({ where: { key: "home" } }))?.draftJson ?? null, null, "invalid content was never stored");
});

// ---- draft, publish, isolation ----------------------------------------------------------------------------------------------

let sa: Session;
const A = marker("CMS marker A");
const B = marker("CMS marker B");

test("a saved draft is stored, versioned and invisible to the public page and the public reader", async () => {
  sa = await sessionFor("SUPER_ADMIN", "cmsflow");
  const s0 = await state(sa);
  assert.equal(s0.publishedVersion, 0);
  assert.equal(s0.hasDraft, false);
  assert.equal(s0.editingSource, "defaults");

  const r = await saveD(sa, withIntro(A), s0.draftVersion);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.draftVersion, s0.draftVersion + 1);
  assert.equal(r.json.draftBaseVersion, 0);
  assert.equal(r.json.state.hasDraft, true);
  assert.equal(r.json.state.editing.hero.intro, A);

  // The public reader and the public HTML never see a draft.
  assert.equal((await getPublishedSiteContentResolved("home")).source, "defaults");
  const html = await (await fetch(`${BASE}/`)).text();
  assert.ok(!html.includes(A));
  // The Super Admin preview shows the saved draft; the published view does not.
  assert.ok((await pageRes(sa, "/website-preview")).text.includes(A));
  assert.ok(!(await pageRes(sa, "/website-preview?view=published")).text.includes(A));
  // The raw draft columns are not exposed by any public endpoint.
  assert.equal((await fetch(`${BASE}/api/admin/website-content`)).status, 401);
});

test("saving with a stale draft version is a 409 and changes nothing", async () => {
  const s = await state(sa);
  const r = await saveD(sa, withIntro(marker("never saved")), s.draftVersion - 1);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "version_conflict");
  assert.equal((await state(sa)).editing.hero.intro, A);
});

test("publishing needs the current draft and published versions; success returns only after the commit and writes the revision", async () => {
  const s = await state(sa);
  assert.equal((await publishD(sa, s.draftVersion + 1, s.publishedVersion)).status, 409, "wrong draft version");
  assert.equal((await publishD(sa, s.draftVersion, s.publishedVersion + 1)).status, 409, "wrong published version");
  assert.equal((await db.siteContentRevision.count({ where: { contentKey: "home" } })), 0);

  const r = await publishD(sa, s.draftVersion, s.publishedVersion, "first publish");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.version, 1);
  assert.equal(r.json.revalidated, true);
  assert.equal(r.json.state.publishedVersion, 1);
  assert.equal(r.json.state.hasDraft, false);

  // Committed, immutable, attributed, hashed.
  const rev = await db.siteContentRevision.findFirstOrThrow({ where: { contentKey: "home", version: 1 } });
  const user = await db.user.findUniqueOrThrow({ where: { id: sa.userId } });
  assert.equal(rev.kind, "publish");
  assert.equal(rev.authorId, sa.userId);
  assert.equal(rev.authorName, user.name);
  assert.equal(rev.note, "first publish");
  assert.equal(rev.contentHash, contentHash(rev.contentJson), "the stored hash is the canonical hash of the stored content, even after JSONB reorders keys");
  assert.equal(rev.contentHash, contentHash(withIntro(A)));
  const row = await db.siteContent.findUniqueOrThrow({ where: { key: "home" } });
  assert.equal(row.draftJson, null);
  assert.equal(row.publishedVersion, 1);
  assert.equal(row.publishedById, sa.userId);

  // Secondary audit trail.
  const log = await db.activityLog.findFirst({ where: { userId: sa.userId, action: "cms.publish" } });
  assert.ok(log, "ActivityLog records the publish");
  assert.ok(!(log?.meta ?? "").includes(A), "the log holds identifiers, not content");

  // The public reader uses it at once; the public HTML follows via revalidation.
  const resolved = await getPublishedSiteContentResolved("home");
  assert.equal(resolved.source, "published");
  assert.equal(resolved.version, 1);
  assert.equal(resolved.content.hero.intro, A);
  const took = await publicHtmlHas(A);
  assert.notEqual(took, null, "the public homepage showed the published wording");
  console.log(`[info] public homepage showed the published wording after ${took} ms`);
});

test("nothing to publish: no draft, and a draft identical to the published content, are both refused", async () => {
  const s = await state(sa);
  assert.equal((await publishD(sa, s.draftVersion, s.publishedVersion)).json.code, "no_draft");
  const same = await saveD(sa, withIntro(A), s.draftVersion);
  assert.equal(same.status, 200);
  const r = await publishD(sa, same.json.draftVersion, same.json.state.publishedVersion);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "no_changes");
});

test("concurrent saves: exactly one wins; the loser gets a 409", async () => {
  const s = await state(sa);
  const results = await Promise.all([saveD(sa, withIntro(marker("race one")), s.draftVersion), saveD(sa, withIntro(marker("race two")), s.draftVersion)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await state(sa)).draftVersion, s.draftVersion + 1);
});

test("concurrent publishes: exactly one new revision is created, the other request is a 409", async () => {
  // A fresh draft that differs from what is published.
  let s = await state(sa);
  const saved = await saveD(sa, withIntro(B), s.draftVersion);
  assert.equal(saved.status, 200);
  s = saved.json.state;
  const before = await db.siteContentRevision.count({ where: { contentKey: "home" } });
  const results = await Promise.all([publishD(sa, s.draftVersion, s.publishedVersion), publishD(sa, s.draftVersion, s.publishedVersion), publishD(sa, s.draftVersion, s.publishedVersion)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409], JSON.stringify(results.map((r) => r.json?.code)));
  assert.equal(await db.siteContentRevision.count({ where: { contentKey: "home" } }), before + 1);
  const now = await state(sa);
  assert.equal(now.publishedVersion, s.publishedVersion + 1);
  assert.equal(now.published.hero.intro, B);
});

// ---- rollback ---------------------------------------------------------------------------------------------------------------

test("rollback restores an old snapshot as a NEW revision, keeps history, preserves an unsaved draft and marks its base stale", async () => {
  let s = await state(sa);
  const draftMarker = marker("work in progress");
  const d = await saveD(sa, withIntro(draftMarker), s.draftVersion);
  assert.equal(d.status, 200);
  s = d.json.state;
  const draftBefore = (await db.siteContent.findUniqueOrThrow({ where: { key: "home" } })).draftJson;
  const revisionsBefore = await db.siteContentRevision.findMany({ where: { contentKey: "home" }, orderBy: { version: "asc" } });

  assert.equal((await rollbackD(sa, 99, s.publishedVersion)).json.code, "no_such_revision");
  assert.equal((await rollbackD(sa, s.publishedVersion, s.publishedVersion)).json.code, "already_current");
  assert.equal((await rollbackD(sa, 1, s.publishedVersion + 1)).status, 409, "stale expected published version");

  const r = await rollbackD(sa, 1, s.publishedVersion);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.version, s.publishedVersion + 1);
  assert.equal(r.json.restoredFromVersion, 1);
  const rev = await db.siteContentRevision.findFirstOrThrow({ where: { contentKey: "home", version: r.json.version } });
  assert.equal(rev.kind, "rollback");
  assert.equal(rev.restoredFromVersion, 1);
  assert.equal(rev.contentHash, revisionsBefore[0].contentHash, "restored content has the original's hash");

  // Old revisions untouched, nothing deleted.
  const revisionsAfter = await db.siteContentRevision.findMany({ where: { contentKey: "home" }, orderBy: { version: "asc" } });
  assert.deepEqual(revisionsAfter.slice(0, revisionsBefore.length), revisionsBefore);
  assert.equal(revisionsAfter.length, revisionsBefore.length + 1);

  // Published is v1's wording again; the unsaved draft is exactly as it was, and now stale.
  assert.equal((await getPublishedSiteContentResolved("home")).content.hero.intro, A);
  const row = await db.siteContent.findUniqueOrThrow({ where: { key: "home" } });
  assert.deepEqual(row.draftJson, draftBefore);
  const after = await state(sa);
  assert.equal(after.hasDraft, true);
  assert.equal(after.draftStale, true);

  // A stale draft cannot be published, not even by saving it again; re-basing is explicit.
  assert.equal((await publishD(sa, after.draftVersion, after.publishedVersion)).json.code, "stale_draft");
  const resaved = await saveD(sa, withIntro(draftMarker), after.draftVersion);
  assert.equal(resaved.json.state.draftStale, true, "a plain save does not re-base");
  assert.equal((await publishD(sa, resaved.json.state.draftVersion, resaved.json.state.publishedVersion)).json.code, "stale_draft");
  const rebased = await saveD(sa, withIntro(draftMarker), resaved.json.state.draftVersion, { rebase: true });
  assert.equal(rebased.json.state.draftStale, false);
  assert.equal(rebased.json.state.draftBaseVersion, rebased.json.state.publishedVersion);
  const done = await publishD(sa, rebased.json.state.draftVersion, rebased.json.state.publishedVersion);
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal((await getPublishedSiteContentResolved("home")).content.hero.intro, draftMarker);
});

test("the revision list is complete, ordered and attributed; contents are not leaked into it", async () => {
  const s = await state(sa);
  const versions = s.revisions.map((r: { version: number }) => r.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => b - a));
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(versions[0], s.publishedVersion);
  assert.ok(s.revisions.some((r: { kind: string; restoredFromVersion: number }) => r.kind === "rollback" && r.restoredFromVersion === 1));
  assert.ok(s.revisions.every((r: Record<string, unknown>) => r.authorName && r.contentHash && !("contentJson" in r)));
});

// ---- store-level safety (unique keys, no HTTP) ---------------------------------------------------------------------------

const actor = () => ({ userId: "test-actor", name: "Test Actor" });
const newKey = () => `t-${randomUUID().slice(0, 12)}`;

async function publishedKey(intros: string[]) {
  const key = newKey();
  for (const intro of intros) {
    const st = await getState(key);
    const d = await saveDraft(key, actor(), { content: withIntro(intro), expectedDraftVersion: st.draftVersion });
    assert.ok(d.ok, JSON.stringify(d));
    const p = await publish(key, actor(), { expectedDraftVersion: d.ok ? d.value.draftVersion : 0, expectedPublishedVersion: st.publishedVersion });
    assert.ok(p.ok, JSON.stringify(p));
  }
  return key;
}

test("a failure inside the publish transaction leaves everything exactly as it was (atomicity)", async () => {
  const key = await publishedKey([marker("one")]);
  const st = await getState(key);
  const d = await saveDraft(key, actor(), { content: withIntro(marker("two")), expectedDraftVersion: st.draftVersion });
  assert.ok(d.ok);
  // Sabotage: a revision row already occupies the next version number, so the revision insert inside the transaction fails.
  await db.$executeRawUnsafe(`INSERT INTO "SiteContentRevision" ("id","contentKey","version","kind","contentJson","schemaVersion","authorId","authorName","contentHash") VALUES ($1,$2,2,'publish','{"x":1}'::jsonb,1,'x','x',$3)`, randomUUID(), key, "b".repeat(64));
  const before = await db.siteContent.findUniqueOrThrow({ where: { key } });
  const r = await publish(key, actor(), { expectedDraftVersion: d.ok ? d.value.draftVersion : 0, expectedPublishedVersion: st.publishedVersion });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.status, 409);
  const after = await db.siteContent.findUniqueOrThrow({ where: { key } });
  assert.deepEqual(after, before, "the content row (published pointer AND draft) is untouched");
  assert.equal(await db.siteContentRevision.count({ where: { contentKey: key } }), 2, "no extra revision");
});

test("a stored draft that no longer validates cannot be published, and nothing changes", async () => {
  const key = await publishedKey([marker("one")]);
  const st = await getState(key);
  const d = await saveDraft(key, actor(), { content: withIntro(marker("two")), expectedDraftVersion: st.draftVersion });
  assert.ok(d.ok);
  const tampered = clone(withIntro("x")) as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  tampered.hero.intro = "<script>alert(1)</script>";
  await db.$executeRawUnsafe(`UPDATE "SiteContent" SET "draftJson" = $1::jsonb WHERE "key" = $2`, JSON.stringify(tampered), key);
  const before = await db.siteContent.findUniqueOrThrow({ where: { key } });
  const r = await publish(key, actor(), { expectedDraftVersion: d.ok ? d.value.draftVersion : 0, expectedPublishedVersion: st.publishedVersion });
  assert.equal(!r.ok && r.code, "invalid_content");
  assert.deepEqual(await db.siteContent.findUniqueOrThrow({ where: { key } }), before);
});

test("rollback refuses snapshots from another schema version or that fail their integrity check; neither changes anything", async () => {
  const key = await publishedKey([marker("one"), marker("two")]); // versions 1 and 2, published = 2
  const content = JSON.stringify(withIntro("snapshot"));
  const insert = (version: number, schemaVersion: number, hash: string) =>
    db.$executeRawUnsafe(`INSERT INTO "SiteContentRevision" ("id","contentKey","version","kind","contentJson","schemaVersion","authorId","authorName","contentHash") VALUES ($1,$2,$3,'publish',$4::jsonb,$5,'x','x',$6)`, randomUUID(), key, version, content, schemaVersion, hash);
  await insert(3, 99, contentHash(withIntro("snapshot"))); // another schema version
  await insert(4, 1, "c".repeat(64)); // right schema version, hash does not match the content
  await db.$executeRawUnsafe(`UPDATE "SiteContent" SET "publishedVersion" = 5 WHERE "key" = $1`, key);
  const before = await db.siteContent.findUniqueOrThrow({ where: { key } });

  const incompatible = await rollback(key, actor(), { toVersion: 3, expectedPublishedVersion: 5 });
  assert.equal(!incompatible.ok && incompatible.code, "incompatible_snapshot");
  const integrity = await rollback(key, actor(), { toVersion: 4, expectedPublishedVersion: 5 });
  assert.equal(!integrity.ok && integrity.code, "integrity_failed");
  const missing = await rollback(key, actor(), { toVersion: 6, expectedPublishedVersion: 5 });
  assert.equal(!missing.ok && missing.code, "no_such_revision");

  assert.equal(await db.siteContentRevision.count({ where: { contentKey: key } }), 4, "no revision was added");
  assert.deepEqual(await db.siteContent.findUniqueOrThrow({ where: { key } }), before, "the content row is untouched");
});

test("stored published content that is invalid, or from another schema version, falls back to the built-in content", async () => {
  const bad = newKey();
  await db.$executeRawUnsafe(`INSERT INTO "SiteContent" ("key","publishedJson","publishedVersion","updatedAt") VALUES ($1,'{"hero":{"intro":"<b>x</b>"}}'::jsonb,1,now())`, bad);
  const r1 = await getPublishedSiteContentResolved(bad);
  assert.equal(r1.source, "defaults");
  assert.deepEqual(r1.content, DEFAULT_SITE_CONTENT);

  const old = newKey();
  await db.$executeRawUnsafe(`INSERT INTO "SiteContent" ("key","publishedJson","publishedVersion","schemaVersion","updatedAt") VALUES ($1,$2::jsonb,1,2,now())`, old, JSON.stringify(defaults()));
  assert.equal((await getPublishedSiteContentResolved(old)).source, "defaults");
  const row = await db.siteContent.findUniqueOrThrow({ where: { key: old } });
  assert.equal(row.schemaVersion, 2, "incompatible stored content is not rewritten");
});

test("post-commit steps are best effort: a failing cache refresh and a failing activity log are reported, never thrown", async () => {
  // Outside a Next.js request revalidatePath throws; the actor does not exist, so the activity insert violates its foreign key.
  const r = await afterCommit({ userId: "no-such-user", name: "x", email: "x@test.example", role: "SUPER_ADMIN", permissions: [] }, "cms.publish", { key: "home" }, { revalidate: true });
  assert.deepEqual(r, { revalidated: false, activityLogged: false });
});

// ---- real company data stays untouched --------------------------------------------------------------------------------------

test("publishing, rolling back and saving drafts never touch company records or the statistics", async () => {
  const snapshot = async () => ({
    companies: await db.company.count(),
    newest: (await db.company.aggregate({ _max: { updatedAt: true } }))._max.updatedAt?.toISOString() ?? null,
    breakdown: await getRegisterBreakdown(0),
    stats: JSON.stringify(await getPublicSiteStats()),
    runs: await db.ingestionRun.count(),
  });
  const before = await snapshot();
  const s = await state(sa);
  const d = await saveD(sa, withIntro(marker("stats safety")), s.draftVersion, { rebase: true });
  assert.equal(d.status, 200);
  const p = await publishD(sa, d.json.state.draftVersion, d.json.state.publishedVersion);
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const rb = await rollbackD(sa, 1, p.json.state.publishedVersion);
  assert.equal(rb.status, 200);
  assert.deepEqual(await snapshot(), before);
});
