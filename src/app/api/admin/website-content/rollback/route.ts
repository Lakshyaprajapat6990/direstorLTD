import { NextResponse } from "next/server";
import { requireSuperAdminForCms } from "@/lib/site-content/guard";
import { readMutationJson } from "@/lib/site-content/request";
import { rollback } from "@/lib/site-content/store";
import { CONTENT_KEY, actorOf, afterCommit, badBody, currentState, rollbackBody, storeError } from "@/lib/site-content/route-helpers";

// Super Admin only. Restores an older published snapshot as a NEW revision (history is never rewritten) and leaves any
// unsaved draft untouched.
export async function POST(request: Request) {
  const auth = await requireSuperAdminForCms();
  if ("error" in auth) return auth.error;
  const body = await readMutationJson(request);
  if (!body.ok) return body.response;
  const parsed = rollbackBody.safeParse(body.json);
  if (!parsed.success) return badBody(parsed.error);

  const result = await rollback(CONTENT_KEY, actorOf(auth.session), parsed.data);
  if (!result.ok) return storeError(result);
  const after = await afterCommit(auth.session, "cms.rollback", { key: CONTENT_KEY, version: result.value.version, from: result.value.restoredFromVersion }, { revalidate: true });
  const s = await currentState();
  return NextResponse.json({ ok: true, ...result.value, ...after, state: s.ok ? s.state : null }, { headers: { "Cache-Control": "no-store" } });
}
