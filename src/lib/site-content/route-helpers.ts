import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logActivity } from "@/lib/activity";
import { makeLogger } from "@/lib/log";
import type { SessionPayload } from "@/lib/auth/session";
import { getState, isMissingTable, noteSchema, type Actor, type StoreResult } from "./store";

const log = makeLogger("site-content");

export const CONTENT_KEY = "home";

const version = z.number().int().min(0).max(1_000_000_000);

export const draftBody = z.object({ content: z.unknown(), expectedDraftVersion: version, rebase: z.boolean().optional() }).strict();
export const publishBody = z.object({ expectedDraftVersion: version, expectedPublishedVersion: version, note: noteSchema }).strict();
export const rollbackBody = z.object({ toVersion: version.min(1), expectedPublishedVersion: version, note: noteSchema }).strict();

export const actorOf = (s: SessionPayload): Actor => ({ userId: s.userId, name: s.name });

export function badBody(error: z.ZodError) {
  const issues = error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message }));
  return NextResponse.json({ error: "The request body is not valid.", code: "bad_request", issues }, { status: 400 });
}

export function storeError<T>(r: Extract<StoreResult<T>, { ok: false }>) {
  return NextResponse.json({ error: r.error, code: r.code, ...(r.issues ? { issues: r.issues } : {}), ...(r.current ? { current: r.current } : {}) }, { status: r.status });
}

// The database work is already committed when this runs. Neither step can turn that into a failure: each is attempted on its
// own, and the response reports honestly what happened.
export async function afterCommit(session: SessionPayload, action: "cms.draft.save" | "cms.publish" | "cms.rollback", meta: Record<string, unknown>, opts: { revalidate: boolean }) {
  let revalidated: boolean | null = null;
  if (opts.revalidate) {
    try {
      revalidatePath("/");
      revalidated = true;
    } catch (err) {
      revalidated = false;
      log.error("revalidatePath failed after a committed change; the page will refresh on its own schedule", { action, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // logActivity never throws and never changes the outcome; draft saves are de-duplicated so autosaving cannot flood the log.
  const logged = await logActivity({ userId: session.userId, sid: session.sid }, action, { meta, ...(action === "cms.draft.save" ? { dedupeMs: 60_000, dedupeSameMeta: false } : {}) });
  return { revalidated, activityLogged: logged };
}

export async function currentState() {
  try {
    return { ok: true as const, state: await getState(CONTENT_KEY) };
  } catch (err) {
    if (isMissingTable(err)) return { ok: false as const, response: NextResponse.json({ error: "Website Content is not set up in this database yet (the migration has not been applied).", code: "not_migrated" }, { status: 503 }) };
    throw err;
  }
}
