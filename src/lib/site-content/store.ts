import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { z } from "zod";
import { DEFAULT_SITE_CONTENT } from "./defaults";
import { contentHash } from "./canonical";
import { CURRENT_SCHEMA_VERSION, MAX_NOTE_LENGTH, mediaIdsIn, parseEditableContent, toEditable, type ContentIssue, type EditableContent } from "./schema";
import { missingMediaIds } from "./media-store";

// All database access for Website Content. Nothing here touches Company, Report, ingestion or any permission table, and
// nothing here calls revalidatePath or writes the ActivityLog: those happen in the route handlers, strictly AFTER the primary
// transaction below has committed, so a failure of either can never be reported as a failed save/publish/rollback.
//
// Concurrency: every mutation runs in one interactive transaction that first locks the content row (SELECT ... FOR UPDATE),
// then checks the caller's expected versions. Two publishes cannot both succeed: the second waits for the lock, finds the
// published version moved, and gets a 409. The unique (contentKey, version) index is a second, independent barrier.

export type StoreResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; code: string; issues?: ContentIssue[]; current?: Record<string, unknown> };

const fail = (status: number, code: string, error: string, extra: { issues?: ContentIssue[]; current?: Record<string, unknown> } = {}): StoreResult<never> => ({ ok: false, status, code, error, ...extra });

export interface Actor {
  userId: string;
  name: string;
}

export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Plain, single-line, trimmed, at most MAX_NOTE_LENGTH; empty becomes null.
const FORBIDDEN_NOTE = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF<>]");
export const noteSchema = z
  .string()
  .max(MAX_NOTE_LENGTH * 4)
  .transform((s) => s.normalize("NFC").trim())
  .pipe(z.string().max(MAX_NOTE_LENGTH, `A note is at most ${MAX_NOTE_LENGTH} characters.`).refine((s) => !FORBIDDEN_NOTE.test(s), "A note is plain text without line breaks or < >."))
  .transform((s) => (s === "" ? null : s))
  .nullish()
  .transform((s) => s ?? null);

// Content may only point at images that exist (they are permanent once uploaded, so this cannot go stale afterwards).
// Where in the content an image is used (so the message can point at it).
function mediaPath(content: EditableContent, id: string): string {
  for (const [k, r] of Object.entries(content.apart.circles ?? {})) if (r.mediaId === id) return `apart.circles.${k}.mediaId`;
  const u = content.useCases.items.findIndex((i) => i.image?.mediaId === id);
  if (u >= 0) return `useCases.items.${u}.image.mediaId`;
  for (const [i, sec] of content.custom.entries()) {
    if (sec.type === "image" && sec.mediaId === id) return `custom.${i}.mediaId`;
    if (sec.type === "text") {
      const j = sec.blocks.findIndex((b) => b.kind === "image" && b.mediaId === id);
      if (j >= 0) return `custom.${i}.blocks.${j}.mediaId`;
    }
  }
  return "";
}

async function mediaIssues(content: EditableContent): Promise<ContentIssue[]> {
  const missing = await missingMediaIds(mediaIdsIn(content));
  return missing.map((id) => ({ path: mediaPath(content, id), message: "This image no longer exists. Choose another." }));
}

export function isMissingTable(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && (err.code === "P2021" || err.code === "P2010");
}

export interface RevisionDTO {
  version: number;
  kind: "publish" | "rollback";
  restoredFromVersion: number | null;
  note: string | null;
  authorName: string;
  authorId: string;
  contentHash: string;
  createdAt: string;
}

export interface CmsState {
  key: string;
  publishedVersion: number;
  publishedAt: string | null;
  draftVersion: number;
  hasDraft: boolean;
  draftBaseVersion: number | null;
  draftUpdatedAt: string | null;
  // The published version has moved since the draft was started: it must be reviewed and re-based before it can publish.
  draftStale: boolean;
  // What an editor sees first: the draft if there is one, else the published content, else the built-in content.
  editing: EditableContent;
  editingSource: "draft" | "published" | "defaults";
  // The validated published content (null when nothing is published or it no longer validates).
  published: EditableContent | null;
  // Set when stored content (draft or published) no longer validates: it is shown as an issue, never silently fixed.
  storedIssue: string | null;
  defaults: EditableContent;
  revisions: RevisionDTO[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function listRevisions(key = "home", limit = 100): Promise<RevisionDTO[]> {
  const rows = await db.siteContentRevision.findMany({
    where: { contentKey: key },
    orderBy: { version: "desc" },
    take: limit,
    select: { version: true, kind: true, restoredFromVersion: true, note: true, authorName: true, authorId: true, contentHash: true, createdAt: true },
  });
  return rows.map((r) => ({ ...r, kind: r.kind === "rollback" ? "rollback" : "publish", createdAt: r.createdAt.toISOString() }));
}

export async function getState(key = "home"): Promise<CmsState> {
  const [row, revisions] = await Promise.all([db.siteContent.findUnique({ where: { key } }), listRevisions(key)]);
  const defaults = toEditable(DEFAULT_SITE_CONTENT);
  const base = { key, defaults, revisions };
  if (!row) return { ...base, publishedVersion: 0, publishedAt: null, draftVersion: 0, hasDraft: false, draftBaseVersion: null, draftUpdatedAt: null, draftStale: false, editing: defaults, editingSource: "defaults", published: null, storedIssue: null };

  let storedIssue: string | null = null;
  const describe = (what: string, issues: ContentIssue[]) => `Stored ${what} no longer passes validation (${issues.slice(0, 3).map((i) => `${i.path || "root"}: ${i.message}`).join("; ")}).`;
  const draft = row.draftJson == null ? null : parseEditableContent(row.draftJson);
  const published = row.publishedJson == null || row.publishedVersion < 1 || row.schemaVersion !== CURRENT_SCHEMA_VERSION ? null : parseEditableContent(row.publishedJson);
  if (draft && !draft.ok) storedIssue = describe("draft", draft.issues);
  if (row.publishedJson != null && row.schemaVersion !== CURRENT_SCHEMA_VERSION) storedIssue = `Published content uses schema version ${row.schemaVersion}, which this version of the site cannot render; the built-in content is shown publicly.`;
  else if (published && !published.ok) storedIssue = describe("published content", published.issues);

  const hasDraft = row.draftJson != null;
  const editing = draft?.ok ? draft.content : published?.ok ? published.content : defaults;
  const editingSource = draft?.ok ? "draft" : published?.ok ? "published" : "defaults";
  return {
    ...base,
    publishedVersion: row.publishedVersion,
    publishedAt: iso(row.publishedAt),
    draftVersion: row.draftVersion,
    hasDraft,
    draftBaseVersion: row.draftBaseVersion,
    draftUpdatedAt: iso(row.draftUpdatedAt),
    draftStale: hasDraft && row.draftBaseVersion !== row.publishedVersion,
    editing,
    editingSource,
    published: published?.ok ? published.content : null,
    storedIssue,
  };
}

interface Locked {
  draftVersion: number;
  draftBaseVersion: number | null;
  publishedVersion: number;
  hasDraft: boolean;
  draftJson: unknown;
  publishedJson: unknown;
}

async function lock(tx: Prisma.TransactionClient, key: string): Promise<Locked | null> {
  const rows = await tx.$queryRaw<Locked[]>`SELECT "draftVersion", "draftBaseVersion", "publishedVersion", ("draftJson" IS NOT NULL) AS "hasDraft", "draftJson", "publishedJson" FROM "SiteContent" WHERE "key" = ${key} FOR UPDATE`;
  return rows[0] ?? null;
}

const conflict = (what: string, current: Record<string, unknown>) => fail(409, "version_conflict", `${what} Reload to see the current state.`, { current });

async function guarded<T>(fn: () => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return fail(409, "version_conflict", "Another change was saved at the same moment. Reload to see the current state.");
    throw err;
  }
}

const authorName = (a: Actor) => (a.name.trim() || "Unknown").slice(0, 200);

// ---- draft ---------------------------------------------------------------------------------------------------------------

export async function saveDraft(key: string, actor: Actor, input: { content: unknown; expectedDraftVersion: number; rebase?: boolean }): Promise<StoreResult<{ draftVersion: number; draftBaseVersion: number }>> {
  if (!KEY_PATTERN.test(key)) return fail(400, "bad_key", "Invalid content key.");
  const parsed = parseEditableContent(input.content);
  if (!parsed.ok) return fail(422, "invalid_content", "The content did not pass validation.", { issues: parsed.issues });
  const missingImages = await mediaIssues(parsed.content);
  if (missingImages.length) return fail(422, "invalid_content", "The content did not pass validation.", { issues: missingImages });
  await db.siteContent.createMany({ data: [{ key }], skipDuplicates: true }); // the lazily created row; idempotent
  return guarded(() =>
    db.$transaction(async (tx) => {
      const row = await lock(tx, key);
      if (!row) return fail(500, "no_row", "Content row missing.");
      if (row.draftVersion !== input.expectedDraftVersion) return conflict("The draft was changed by someone else since you opened it.", { draftVersion: row.draftVersion, publishedVersion: row.publishedVersion });
      // A new draft starts from what is published now. An existing draft keeps the base it started from until the editor
      // explicitly re-bases it, so a stale draft cannot quietly become publishable by being saved again.
      const base = !row.hasDraft || input.rebase ? row.publishedVersion : (row.draftBaseVersion ?? row.publishedVersion);
      const updated = await tx.siteContent.update({
        where: { key },
        data: { draftJson: parsed.content as unknown as Prisma.InputJsonValue, draftVersion: row.draftVersion + 1, draftBaseVersion: base, draftUpdatedAt: new Date(), draftUpdatedById: actor.userId },
        select: { draftVersion: true, draftBaseVersion: true },
      });
      return { ok: true, value: { draftVersion: updated.draftVersion, draftBaseVersion: updated.draftBaseVersion ?? base } };
    })
  );
}

// ---- publish -------------------------------------------------------------------------------------------------------------

export interface PublishInput {
  expectedDraftVersion: number;
  expectedPublishedVersion: number;
  note?: string | null;
}

export async function publish(key: string, actor: Actor, input: PublishInput): Promise<StoreResult<{ version: number; contentHash: string }>> {
  if (!KEY_PATTERN.test(key)) return fail(400, "bad_key", "Invalid content key.");
  return guarded(() =>
    db.$transaction(async (tx) => {
      const row = await lock(tx, key);
      if (!row || !row.hasDraft) return fail(409, "no_draft", "There is no saved draft to publish.");
      const current = { draftVersion: row.draftVersion, publishedVersion: row.publishedVersion };
      if (row.draftVersion !== input.expectedDraftVersion) return conflict("The draft changed since you last loaded it.", current);
      if (row.publishedVersion !== input.expectedPublishedVersion) return conflict("The published version changed since you last loaded it.", current);
      if (row.draftBaseVersion !== row.publishedVersion) return fail(409, "stale_draft", `This draft was started from version ${row.draftBaseVersion}, but version ${row.publishedVersion} is now published. Review the draft and re-base it (save with "re-base") before publishing.`, { current: { ...current, draftBaseVersion: row.draftBaseVersion } });

      const draft = parseEditableContent(row.draftJson);
      if (!draft.ok) return fail(422, "invalid_content", "The stored draft no longer passes validation.", { issues: draft.issues });
      const missingImages = await mediaIssues(draft.content);
      if (missingImages.length) return fail(422, "invalid_content", "The draft refers to an image that no longer exists.", { issues: missingImages });
      const hash = contentHash(draft.content);
      if (row.publishedVersion > 0) {
        const live = parseEditableContent(row.publishedJson);
        if (live.ok && contentHash(live.content) === hash) return fail(409, "no_changes", "The draft is identical to the published content; there is nothing to publish.");
      }

      const version = row.publishedVersion + 1;
      await tx.siteContentRevision.create({
        data: { contentKey: key, version, kind: "publish", contentJson: draft.content as unknown as Prisma.InputJsonValue, schemaVersion: CURRENT_SCHEMA_VERSION, note: input.note ?? null, authorId: actor.userId, authorName: authorName(actor), contentHash: hash },
      });
      await tx.siteContent.update({
        where: { key },
        data: {
          publishedJson: draft.content as unknown as Prisma.InputJsonValue,
          publishedVersion: version,
          publishedAt: new Date(),
          publishedById: actor.userId,
          schemaVersion: CURRENT_SCHEMA_VERSION,
          draftJson: Prisma.DbNull,
          draftBaseVersion: null,
          draftUpdatedAt: null,
          draftUpdatedById: null,
        },
      });
      return { ok: true, value: { version, contentHash: hash } };
    })
  );
}

// ---- rollback ------------------------------------------------------------------------------------------------------------

export interface RollbackInput {
  toVersion: number;
  expectedPublishedVersion: number;
  note?: string | null;
}

// Restores an older published snapshot as a NEW revision. History is never edited. An unsaved draft is left untouched; because
// the published version moves, that draft's base becomes stale and it must be re-based before it can publish.
export async function rollback(key: string, actor: Actor, input: RollbackInput): Promise<StoreResult<{ version: number; restoredFromVersion: number; contentHash: string }>> {
  if (!KEY_PATTERN.test(key)) return fail(400, "bad_key", "Invalid content key.");
  return guarded(() =>
    db.$transaction(async (tx) => {
      const row = await lock(tx, key);
      if (!row) return fail(404, "no_content", "There is no published history yet.");
      const current = { publishedVersion: row.publishedVersion, draftVersion: row.draftVersion };
      if (row.publishedVersion !== input.expectedPublishedVersion) return conflict("The published version changed since you last loaded it.", current);
      if (input.toVersion === row.publishedVersion) return fail(409, "already_current", "That version is already the published one.");
      const source = await tx.siteContentRevision.findUnique({ where: { contentKey_version: { contentKey: key, version: input.toVersion } } });
      if (!source) return fail(404, "no_such_revision", `Version ${input.toVersion} does not exist.`);
      if (source.schemaVersion !== CURRENT_SCHEMA_VERSION) return fail(422, "incompatible_snapshot", `Version ${source.version} was saved with schema version ${source.schemaVersion}; this site uses ${CURRENT_SCHEMA_VERSION}, so it cannot be restored.`);
      const parsed = parseEditableContent(source.contentJson);
      if (!parsed.ok) return fail(422, "incompatible_snapshot", `Version ${source.version} no longer passes the current content rules and cannot be restored.`, { issues: parsed.issues });
      const missingImages = await mediaIssues(parsed.content);
      if (missingImages.length) return fail(422, "incompatible_snapshot", `Version ${source.version} refers to an image that no longer exists and cannot be restored.`, { issues: missingImages });
      const hash = contentHash(parsed.content);
      if (hash !== source.contentHash) return fail(422, "integrity_failed", `Version ${source.version} failed its integrity check (stored hash does not match its content); it was not restored.`);

      const version = row.publishedVersion + 1;
      await tx.siteContentRevision.create({
        data: { contentKey: key, version, kind: "rollback", restoredFromVersion: source.version, contentJson: parsed.content as unknown as Prisma.InputJsonValue, schemaVersion: CURRENT_SCHEMA_VERSION, note: input.note ?? null, authorId: actor.userId, authorName: authorName(actor), contentHash: hash },
      });
      await tx.siteContent.update({
        where: { key },
        data: { publishedJson: parsed.content as unknown as Prisma.InputJsonValue, publishedVersion: version, publishedAt: new Date(), publishedById: actor.userId, schemaVersion: CURRENT_SCHEMA_VERSION },
      });
      return { ok: true, value: { version, restoredFromVersion: source.version, contentHash: hash } };
    })
  );
}
