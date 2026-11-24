// One-off: copies profile pictures written by an older build from the filesystem into the database (table UserAvatar), which is
// where they now live so they survive on hosts with a read-only or ephemeral filesystem. Run it once per environment that has
// pictures on disk, AFTER applying the migrations:
//   npm run avatars:import              # copy, keeping anything already in the database
//   npm run avatars:import -- --force   # also replace pictures the database already has
//   npm run avatars:import -- --prune   # delete each file once it is safely in the database
// Safe to re-run: without --force a user already holding a picture in the database is skipped. Reads the same directory the old
// build wrote to (AVATAR_DIR, default ./data/avatars); if that directory is absent there is simply nothing to do.
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "../src/lib/db";
import { AVATAR_MAX_BYTES, AVATAR_TYPES, detectImageType, isUserId, type AvatarExt } from "../src/lib/avatar";

const dir = () => path.resolve(process.env.AVATAR_DIR || path.join(process.cwd(), "data", "avatars"));

async function main() {
  const force = process.argv.includes("--force");
  const prune = process.argv.includes("--prune");
  const from = dir();

  let names: string[];
  try {
    names = await fs.readdir(from);
  } catch {
    console.log(`No picture directory at ${from} - nothing to import.`);
    return;
  }

  const exts = Object.keys(AVATAR_TYPES) as AvatarExt[];
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of names) {
    const ext = path.extname(name).slice(1).toLowerCase();
    const userId = path.basename(name, path.extname(name));
    // Ignore the old build's leftover ".<id>.<ts>.tmp" part-files and anything else that is not a finished picture.
    if (name.startsWith(".") || !exts.includes(ext as AvatarExt) || !isUserId(userId)) continue;

    const file = path.join(from, name);
    try {
      const bytes = await fs.readFile(file);
      if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES) throw new Error(`unusable size (${bytes.length} bytes)`);
      // Trust the bytes, not the file name: the extension on disk may disagree with what the file actually is.
      const real = detectImageType(bytes);
      if (!real) throw new Error("not a JPEG, PNG or WebP image");

      const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new Error("no such user (the account was deleted)");

      const existing = await db.userAvatar.findUnique({ where: { userId }, select: { userId: true } });
      if (existing && !force) {
        skipped++;
        continue;
      }

      // The file's own mtime becomes the version, so a browser holding the old /api/profile/avatar URL keeps its cached copy.
      const updatedAt = await fs.stat(file).then((s) => s.mtime, () => new Date());
      const data = { ext: real, byteSize: bytes.length, data: bytes, updatedAt };
      await db.userAvatar.upsert({ where: { userId }, create: { userId, ...data }, update: data });
      imported++;
      if (prune) await fs.rm(file, { force: true });
    } catch (err) {
      failed++;
      console.error(`${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`Imported ${imported}, skipped ${skipped} (already in the database), failed ${failed}.`);
  if (imported && !prune) console.log(`The files are still in ${from}; they are no longer read. Re-run with --prune to remove them.`);
  if (failed) process.exitCode = 1;
}

main()
  .then(() => db.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
