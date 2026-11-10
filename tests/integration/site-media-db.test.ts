import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "./helpers";

after(async () => {
  await db.$disconnect();
});

// Real PostgreSQL (scratch only). Image rows are immutable and permanent, so each test uses its own random ids and bytes.

const hex = (n: number) => randomBytes(n / 2).toString("hex");
const png = Buffer.from(JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/images.json"), "utf8")).png.base64, "base64");

async function expectDbError(p: Promise<unknown>, pattern: RegExp, label: string) {
  await assert.rejects(p, (e: Error) => {
    assert.match(String(e.message) + JSON.stringify((e as { meta?: unknown }).meta ?? {}), pattern, label);
    return true;
  });
}

const insert = (o: Partial<{ id: string; mime: string; size: number; w: number; h: number; sha: string; data: Buffer; name: string | null; by: string; byName: string }> = {}) => {
  const data = o.data ?? Buffer.concat([png, randomBytes(8)]);
  return db.$executeRawUnsafe(
    `INSERT INTO "SiteMedia" ("id","mimeType","byteSize","width","height","sha256","data","originalName","uploadedById","uploadedByName") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    o.id ?? hex(32),
    o.mime ?? "image/png",
    o.size ?? data.length,
    o.w ?? 40,
    o.h ?? 20,
    o.sha ?? createHash("sha256").update(data).digest("hex"),
    data,
    o.name === undefined ? "banner.png" : o.name,
    o.by ?? "user-1",
    o.byName ?? "Test Author"
  );
};

test("the media migration creates one table and touches nothing else", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20261024120000_site_media/migration.sql"), "utf8").replace(/--.*$/gm, "");
  assert.ok(!/\bINSERT\s+INTO\b/i.test(sql) && !/\bDROP\b/i.test(sql));
  for (const m of sql.matchAll(/(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX "[^"]+" ON) "([A-Za-z]+)"/g)) assert.equal(m[1], "SiteMedia");
});

test("a valid image row is stored, and the table has no relation to any other table", async () => {
  const id = hex(32);
  await insert({ id });
  const row = await db.siteMedia.findUniqueOrThrow({ where: { id } });
  assert.equal(row.mimeType, "image/png");
  assert.ok(Buffer.isBuffer(row.data) && row.data.length === row.byteSize);
  const fks = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND ('"SiteMedia"'::regclass = conrelid OR '"SiteMedia"'::regclass = confrelid)`);
  assert.equal(fks[0].n, 0);
});

test("only JPEG, PNG and WebP, a size cap that equals the real byte length, sane dimensions, and well-formed ids and hashes", async () => {
  await expectDbError(insert({ mime: "image/svg+xml" }), /SiteMedia_mime_check/, "svg");
  await expectDbError(insert({ mime: "image/gif" }), /SiteMedia_mime_check/, "gif");
  await expectDbError(insert({ mime: "text/html" }), /SiteMedia_mime_check/, "html");
  await expectDbError(insert({ size: 5 }), /SiteMedia_size_check/, "declared size differs from the bytes");
  await expectDbError(insert({ data: Buffer.alloc(0) }), /SiteMedia_size_check/, "empty");
  const big = randomBytes(2_621_441);
  await expectDbError(insert({ data: big }), /SiteMedia_size_check/, "over 2.5 MiB");
  await insert({ data: randomBytes(2_621_440) });
  await expectDbError(insert({ w: 0 }), /SiteMedia_dimensions_check/, "zero width");
  await expectDbError(insert({ h: 10001 }), /SiteMedia_dimensions_check/, "huge height");
  await expectDbError(insert({ id: "../../etc/passwd" }), /SiteMedia_id_check/, "path in id");
  await expectDbError(insert({ id: hex(32).toUpperCase() }), /SiteMedia_id_check/, "upper-case id");
  await expectDbError(insert({ id: hex(16) }), /SiteMedia_id_check/, "short id");
  await expectDbError(insert({ sha: "xyz" }), /SiteMedia_sha256_check/, "bad hash");
  await expectDbError(insert({ name: "n".repeat(121) }), /SiteMedia_text_check/, "file name");
  await expectDbError(insert({ by: "" }), /SiteMedia_text_check/, "uploader id");
});

test("the same bytes cannot be stored twice (one row per hash), and ids are unique", async () => {
  const data = Buffer.concat([png, randomBytes(8)]);
  await insert({ data });
  await expectDbError(insert({ data }), /already exists|23505|Unique constraint/i, "duplicate hash");
  const id = hex(32);
  await insert({ id });
  await expectDbError(insert({ id }), /already exists|23505|Unique constraint/i, "duplicate id");
});

test("images are immutable and permanent: UPDATE, DELETE and TRUNCATE are refused for any caller", async () => {
  const id = hex(32);
  await insert({ id });
  const before = await db.siteMedia.findUniqueOrThrow({ where: { id } });
  await expectDbError(db.$executeRawUnsafe(`UPDATE "SiteMedia" SET "originalName" = 'x' WHERE "id" = $1`, id), /immutable/, "UPDATE");
  await expectDbError(db.$executeRawUnsafe(`UPDATE "SiteMedia" SET "data" = '\\x00'::bytea WHERE "id" = $1`, id), /immutable/, "UPDATE of the bytes");
  await expectDbError(db.siteMedia.update({ where: { id }, data: { width: 1 } }), /immutable/, "Prisma update");
  await expectDbError(db.$executeRawUnsafe(`DELETE FROM "SiteMedia" WHERE "id" = $1`, id), /immutable/, "DELETE");
  await expectDbError(db.siteMedia.delete({ where: { id } }), /immutable/, "Prisma delete");
  await expectDbError(db.siteMedia.deleteMany({ where: { id } }), /immutable/, "Prisma deleteMany");
  await expectDbError(db.$executeRawUnsafe(`TRUNCATE "SiteMedia"`), /immutable/, "TRUNCATE");
  const after = await db.siteMedia.findUniqueOrThrow({ where: { id } });
  assert.deepEqual(after, before);
});

test("deleting the user who uploaded an image changes nothing: the uploader is a snapshot", async () => {
  const user = await db.user.create({ data: { email: `media-author.${randomUUID().slice(0, 8)}@test.example`, name: "Soon Gone", passwordHash: "x", role: "SUPER_ADMIN" } });
  const id = hex(32);
  await insert({ id, by: user.id, byName: "Soon Gone" });
  await db.user.delete({ where: { id: user.id } });
  const row = await db.siteMedia.findUniqueOrThrow({ where: { id } });
  assert.equal(row.uploadedById, user.id);
  assert.equal(row.uploadedByName, "Soon Gone");
});
