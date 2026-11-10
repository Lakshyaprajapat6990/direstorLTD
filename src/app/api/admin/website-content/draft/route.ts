import { NextResponse } from "next/server";
import { requireSuperAdminForCms } from "@/lib/site-content/guard";
import { readMutationJson } from "@/lib/site-content/request";
import { saveDraft } from "@/lib/site-content/store";
import { CONTENT_KEY, actorOf, afterCommit, badBody, currentState, draftBody, storeError } from "@/lib/site-content/route-helpers";

// Super Admin only. Saves the draft (never touches published content). Requires the draft version the editor last saw.
export async function PUT(request: Request) {
  const auth = await requireSuperAdminForCms();
  if ("error" in auth) return auth.error;
  const body = await readMutationJson(request);
  if (!body.ok) return body.response;
  const parsed = draftBody.safeParse(body.json);
  if (!parsed.success) return badBody(parsed.error);

  const result = await saveDraft(CONTENT_KEY, actorOf(auth.session), parsed.data);
  if (!result.ok) return storeError(result);
  const after = await afterCommit(auth.session, "cms.draft.save", { key: CONTENT_KEY, draftVersion: result.value.draftVersion }, { revalidate: false });
  const s = await currentState();
  return NextResponse.json({ ok: true, ...result.value, ...after, state: s.ok ? s.state : null }, { headers: { "Cache-Control": "no-store" } });
}
