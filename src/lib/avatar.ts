import { db } from "@/lib/db";

// Profile pictures live in the database (table UserAvatar), one row per user, keyed by the user's id only - no user-supplied
// name or path is ever used. The type is decided from the file's own bytes, never from its declared MIME type.
//
// They are NOT kept on disk: the app runs on hosts whose filesystem is read-only or thrown away between requests (Vercel and
// other serverless platforms), where a written file is refused outright or silently lost. The database is the only store that
// every deployment shares. Pictures written by an older build are brought across by `npm run avatars:import`.

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
export type AvatarExt = keyof typeof AVATAR_TYPES;
const ID = /^[a-z0-9]{10,40}$/i;

export const isUserId = (id: string) => ID.test(id);

const isAvatarExt = (v: string): v is AvatarExt => v in AVATAR_TYPES;

// JPEG / PNG / WebP by magic number; anything else (SVG, GIF, HTML, a renamed executable...) is refused.
export function detectImageType(b: Uint8Array): AvatarExt | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

// Reports whether this user has a picture and which version it is, WITHOUT reading the bytes: the pages that only need the URL
// (header, Users list, company detail) must not pull every picture's megabytes out of the database to render a link.
export async function findAvatar(userId: string): Promise<{ ext: AvatarExt; mtimeMs: number } | null> {
  if (!isUserId(userId)) return null;
  const row = await db.userAvatar.findUnique({ where: { userId }, select: { ext: true, updatedAt: true } });
  if (!row || !isAvatarExt(row.ext)) return null;
  return { ext: row.ext, mtimeMs: row.updatedAt.getTime() };
}

export async function readAvatar(userId: string, ext: AvatarExt): Promise<Buffer> {
  if (!isUserId(userId)) throw new Error("bad user id");
  const row = await db.userAvatar.findUnique({ where: { userId }, select: { data: true, ext: true } });
  if (!row || row.ext !== ext) throw new Error("no such avatar");
  return Buffer.from(row.data);
}

export async function removeAvatar(userId: string): Promise<void> {
  if (!isUserId(userId)) return;
  await db.userAvatar.deleteMany({ where: { userId } }); // deleteMany: no error when there was no picture
}

// A user has exactly one picture, whatever format it was in before, so this replaces any existing row outright.
export async function saveAvatar(userId: string, ext: AvatarExt, bytes: Buffer): Promise<void> {
  if (!isUserId(userId)) throw new Error("bad user id");
  const data = { ext, byteSize: bytes.length, data: bytes, updatedAt: new Date() };
  await db.userAvatar.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

// The URL the header/settings use; the version changes whenever the picture does, so the browser never shows a stale one.
export const avatarUrl = (userId: string, version: number) => `/api/profile/avatar/${userId}?v=${version}`;
