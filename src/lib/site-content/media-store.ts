import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { MAX_IMAGE_BYTES, cleanFileName, readImageInfo } from "./image-info";
import { MEDIA_ID } from "./sections";
import type { Actor } from "./store";

// Database access for the website editor's images. Nothing here touches any other table. Images live in PostgreSQL so they are
// durable on any hosting, are served by our own /media route (so the existing Content-Security-Policy img-src 'self' still holds),
// and can never go missing underneath a published or historical revision.

export const MAX_MEDIA_COUNT = 60;
export const MAX_MEDIA_TOTAL_BYTES = 64 * 1024 * 1024;

export interface MediaDTO {
  id: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  originalName: string | null;
  uploadedByName: string;
  createdAt: string;
}

const meta = { id: true, mimeType: true, width: true, height: true, byteSize: true, originalName: true, uploadedByName: true, createdAt: true } as const;
const dto = (r: { id: string; mimeType: string; width: number; height: number; byteSize: number; originalName: string | null; uploadedByName: string; createdAt: Date }): MediaDTO => ({ ...r, createdAt: r.createdAt.toISOString() });

export type MediaResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; code: string };
const fail = (status: number, code: string, error: string): MediaResult<never> => ({ ok: false, status, code, error });

export async function listMedia(limit = MAX_MEDIA_COUNT): Promise<MediaDTO[]> {
  return (await db.siteMedia.findMany({ orderBy: { createdAt: "desc" }, take: limit, select: meta })).map(dto);
}

// The bytes are checked here, whatever the caller (route, test, script) claims: real image type and size from the file itself.
export async function saveMedia(actor: Actor, input: { bytes: Uint8Array; fileName?: string | null }): Promise<MediaResult<{ media: MediaDTO; reused: boolean }>> {
  if (input.bytes.length === 0) return fail(400, "empty", "The file is empty.");
  if (input.bytes.length > MAX_IMAGE_BYTES) return fail(413, "too_large", `Images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  const info = readImageInfo(input.bytes);
  if (!info) return fail(415, "not_an_image", "Only JPEG, PNG and WebP images up to 8000 pixels on a side are accepted.");

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existing = await db.siteMedia.findUnique({ where: { sha256 }, select: meta });
  if (existing) return { ok: true, value: { media: dto(existing), reused: true } };

  const totals = await db.siteMedia.aggregate({ _count: { _all: true }, _sum: { byteSize: true } });
  if (totals._count._all >= MAX_MEDIA_COUNT) return fail(409, "library_full", `The image library holds at most ${MAX_MEDIA_COUNT} images.`);
  if ((totals._sum.byteSize ?? 0) + input.bytes.length > MAX_MEDIA_TOTAL_BYTES) return fail(409, "library_full", "The image library is full.");

  const row = await db.siteMedia.create({
    data: {
      id: randomBytes(16).toString("hex"),
      mimeType: info.type,
      byteSize: input.bytes.length,
      width: info.width,
      height: info.height,
      sha256,
      data: Buffer.from(input.bytes),
      originalName: cleanFileName(input.fileName),
      uploadedById: actor.userId,
      uploadedByName: (actor.name.trim() || "Unknown").slice(0, 200),
    },
    select: meta,
  });
  return { ok: true, value: { media: dto(row), reused: false } };
}

// Ids from `ids` that do not exist (used to refuse content that points at a missing image).
export async function missingMediaIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const found = new Set((await db.siteMedia.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id));
  return ids.filter((id) => !found.has(id));
}

export async function getMediaBytes(id: string) {
  if (!MEDIA_ID.test(id)) return null;
  return db.siteMedia.findUnique({ where: { id }, select: { mimeType: true, data: true, sha256: true, byteSize: true } });
}

// An image is public only while the PUBLISHED content refers to it. Drafts and old revisions do not make it public. The id is
// 32 hex characters (validated), so the LIKE pattern can contain no wildcard.
export async function isMediaPublished(id: string): Promise<boolean> {
  if (!MEDIA_ID.test(id)) return false;
  const rows = await db.$queryRaw<{ n: number }[]>`SELECT 1 AS n FROM "SiteContent" WHERE "publishedJson"::text LIKE ${"%" + id + "%"} LIMIT 1`;
  return rows.length > 0;
}
