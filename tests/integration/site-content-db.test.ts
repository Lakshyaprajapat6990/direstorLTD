import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// Real PostgreSQL (the scratch database only: helpers.ts refuses anything else). Revisions are immutable, so these tests
// cannot clean up after themselves; every test therefore uses its own unique content key on the throw-away database.

const HASH = "a".repeat(64);
const newKey = () => `t-${randomUUID().slice(0, 12)}`;

async function expectDbError(p: Promise<unknown>, pattern: RegExp, label: string) {
  await assert.rejects(p, (e: Error) => {
    assert.match(String(e.message) + JSON.stringify((e as { meta?: unknown }).meta ?? {}), pattern, label);
    return true;
  });
}

const insertContent = (key: string, extra: { draft?: string | null; published?: string | null; draftVersion?: number; publishedVersion?: number } = {}) =>
  db.$executeRawUnsafe(
    `INSERT INTO "SiteContent" ("key","draftJson","publishedJson","draftVersion","publishedVersion","updatedAt") VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, now())`,
    key,
    extra.draft ?? null,
    extra.published ?? null,
    extra.draftVersion ?? 0,
    extra.publishedVersion ?? 0
  );

const insertRevision = (key: string, o: Partial<{ version: number; kind: string; json: string; restoredFrom: number | null; note: string | null; authorId: string; hash: string }> = {}) =>
  db.$executeRawUnsafe(
    `INSERT INTO "SiteContentRevision" ("id","contentKey","version","kind","contentJson","schemaVersion","restoredFromVersion","note","authorId","authorName","contentHash") VALUES ($1,$2,$3,$4,$5::jsonb,1,$6,$7,$8,'Test Author',$9)`,
    randomUUID(),
    key,
    o.version ?? 1,
    o.kind ?? "publish",
    o.json ?? '{"a":1}',
    o.restoredFrom ?? null,
    o.note ?? null,
    o.authorId ?? "user-1",
    o.hash ?? HASH
  );

test("the migration only creates the two CMS tables: no inserts, no other table altered, nothing dropped", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20261023120000_site_content/migration.sql"), "utf8");
  const code = sql.replace(/--.*$/gm, "");
  assert.ok(!/\bINSERT\s+INTO\b/i.test(code), "no data is inserted (the home row is created lazily)");
  assert.ok(!/\bDROP\b/i.test(code), "nothing is dropped");
  assert.ok(!/\bUPDATE\s+"/i.test(code.replace(/BEFORE UPDATE OR DELETE/gi, "")), "no data is updated");
  for (const m of code.matchAll(/ALTER TABLE "([A-Za-z]+)"/g)) assert.match(m[1], /^SiteContent(Revision)?$/, `ALTER TABLE on ${m[1]}`);
  for (const m of code.matchAll(/CREATE (?:UNIQUE )?INDEX "[^"]+" ON "([A-Za-z]+)"/g)) assert.match(m[1], /^SiteContent(Revision)?$/, `index on ${m[1]}`);
  for (const m of code.matchAll(/CREATE TABLE "([A-Za-z]+)"/g)) assert.match(m[1], /^SiteContent(Revision)?$/);
});

test("SiteContent: JSON must be an object, size is capped, version columns stay consistent, key length is bounded", async () => {
  await expectDbError(insertContent(newKey(), { draft: "[]" }), /SiteContent_draft_check/, "array draft");
  await expectDbError(insertContent(newKey(), { draft: '"text"' }), /SiteContent_draft_check/, "string draft");
  await expectDbError(insertContent(newKey(), { published: "[1]", publishedVersion: 1 }), /SiteContent_published_check/, "array published");
  const big = JSON.stringify({ x: "a".repeat(131072) });
  await expectDbError(insertContent(newKey(), { draft: big }), /SiteContent_draft_check/, "oversized draft");
  await expectDbError(insertContent(newKey(), { published: big, publishedVersion: 1 }), /SiteContent_published_check/, "oversized published");
  await expectDbError(insertContent(newKey(), { publishedVersion: 1 }), /SiteContent_versions_check/, "published version without content");
  await expectDbError(insertContent(newKey(), { published: '{"a":1}', publishedVersion: 0 }), /SiteContent_versions_check/, "published content at version 0");
  await expectDbError(insertContent(newKey(), { draftVersion: -1 }), /SiteContent_versions_check/, "negative draft version");
  await expectDbError(insertContent(""), /SiteContent_key_check/, "empty key");
  await expectDbError(insertContent("k".repeat(65)), /SiteContent_key_check/, "long key");

  const ok = newKey();
  await insertContent(ok, { draft: '{"a":1}', published: '{"b":2}', publishedVersion: 1 });
  const row = await db.siteContent.findUnique({ where: { key: ok } });
  assert.deepEqual(row?.draftJson, { a: 1 });
  assert.equal(row?.schemaVersion, 1);
  assert.equal(row?.draftVersion, 0);
});

test("SiteContentRevision: kind, version, JSON type and size, rollback linkage, hash format and text limits are enforced", async () => {
  const key = newKey();
  await insertContent(key);
  await expectDbError(insertRevision(key, { kind: "edit" }), /SiteContentRevision_kind_check/, "kind");
  await expectDbError(insertRevision(key, { version: 0 }), /SiteContentRevision_version_check/, "version 0");
  await expectDbError(insertRevision(key, { json: "[]" }), /SiteContentRevision_json_check/, "array json");
  await expectDbError(insertRevision(key, { json: JSON.stringify({ x: "a".repeat(131072) }) }), /SiteContentRevision_json_check/, "oversized json");
  await expectDbError(insertRevision(key, { kind: "rollback", restoredFrom: null }), /SiteContentRevision_rollback_check/, "rollback without source");
  await expectDbError(insertRevision(key, { kind: "publish", restoredFrom: 1 }), /SiteContentRevision_rollback_check/, "publish with source");
  await expectDbError(insertRevision(key, { hash: "XYZ" }), /SiteContentRevision_hash_check/, "hash");
  await expectDbError(insertRevision(key, { hash: "A".repeat(64) }), /SiteContentRevision_hash_check/, "upper-case hash");
  await expectDbError(insertRevision(key, { note: "n".repeat(201) }), /SiteContentRevision_text_check/, "note");
  await expectDbError(insertRevision(key, { authorId: "" }), /SiteContentRevision_text_check/, "author id");
  await expectDbError(insertRevision("no-such-key"), /SiteContentRevision_contentKey_fkey|Foreign key/i, "foreign key");

  await insertRevision(key, { version: 1 });
  await insertRevision(key, { version: 2, kind: "rollback", restoredFrom: 1, note: "n".repeat(200) });
  await expectDbError(insertRevision(key, { version: 2 }), /already exists|23505|Unique constraint|duplicate key/i, "duplicate (key, version)");
  assert.equal(await db.siteContentRevision.count({ where: { contentKey: key } }), 2);
});

test("revisions are append-only: UPDATE, DELETE and TRUNCATE are rejected, for any caller, and the row is unchanged", async () => {
  const key = newKey();
  await insertContent(key);
  await insertRevision(key, { version: 1, json: '{"keep":"me"}' });
  const before = await db.siteContentRevision.findFirstOrThrow({ where: { contentKey: key } });

  await expectDbError(db.$executeRawUnsafe(`UPDATE "SiteContentRevision" SET "note" = 'edited' WHERE "contentKey" = $1`, key), /append-only/, "raw UPDATE");
  await expectDbError(db.$executeRawUnsafe(`UPDATE "SiteContentRevision" SET "contentJson" = '{}'::jsonb WHERE "contentKey" = $1`, key), /append-only/, "raw UPDATE of content");
  await expectDbError(db.siteContentRevision.update({ where: { id: before.id }, data: { note: "edited" } }), /append-only/, "Prisma update");
  await expectDbError(db.$executeRawUnsafe(`DELETE FROM "SiteContentRevision" WHERE "contentKey" = $1`, key), /append-only/, "raw DELETE");
  await expectDbError(db.siteContentRevision.delete({ where: { id: before.id } }), /append-only/, "Prisma delete");
  await expectDbError(db.siteContentRevision.deleteMany({ where: { contentKey: key } }), /append-only/, "Prisma deleteMany");
  await expectDbError(db.$executeRawUnsafe(`TRUNCATE "SiteContentRevision"`), /append-only/, "TRUNCATE");

  const after = await db.siteContentRevision.findFirstOrThrow({ where: { contentKey: key } });
  assert.deepEqual(after, before);
  assert.equal(await db.siteContentRevision.count({ where: { contentKey: key } }), 1);
});

test("a content row that has history cannot be deleted; one without history can", async () => {
  const withHistory = newKey();
  await insertContent(withHistory);
  await insertRevision(withHistory);
  await expectDbError(db.siteContent.delete({ where: { key: withHistory } }), /Foreign key|violates|SiteContentRevision_contentKey_fkey/i, "delete with revisions");
  assert.ok(await db.siteContent.findUnique({ where: { key: withHistory } }));

  const bare = newKey();
  await insertContent(bare);
  await db.siteContent.delete({ where: { key: bare } });
  assert.equal(await db.siteContent.findUnique({ where: { key: bare } }), null);
});

test("deleting a user changes nothing in the CMS tables: authors are snapshots, not foreign keys", async () => {
  const key = newKey();
  await insertContent(key);
  const user = await db.user.create({ data: { email: `cms-author.${randomUUID().slice(0, 8)}@test.example`, name: "Soon Gone", passwordHash: "x", role: "SUPER_ADMIN" } });
  await insertRevision(key, { authorId: user.id });
  await db.user.delete({ where: { id: user.id } });
  const rev = await db.siteContentRevision.findFirstOrThrow({ where: { contentKey: key } });
  assert.equal(rev.authorId, user.id);
  assert.equal(rev.authorName, "Test Author");
});
