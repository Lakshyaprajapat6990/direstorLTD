import { NextResponse } from "next/server";
import { requireSuperAdminForCms } from "@/lib/site-content/guard";
import { readMutationJson } from "@/lib/site-content/request";
import { publish } from "@/lib/site-content/store";
import { CONTENT_KEY, actorOf, afterCommit, badBody, currentState, publishBody, storeError } from "@/lib/site-content/route-helpers";

// Super Admin only. Publishes the saved draft as a new immutable revision. The success response is sent only after the
// database transaction has committed; cache refresh and the activity log are attempted afterwards and reported separately.
export async function POST(request: Request) {
  const auth = await requireSuperAdminForCms();
  if ("error" in auth) return auth.error;
  const body = await readMutationJson(request);
  if (!body.ok) return body.response;
  const parsed = publishBody.safeParse(body.json);
  if (!parsed.success) return badBody(parsed.error);

  const result = await publish(CONTENT_KEY, actorOf(auth.session), parsed.data);
  if (!result.ok) return storeError(result);
  const after = await afterCommit(auth.session, "cms.publish", { key: CONTENT_KEY, version: result.value.version, hash: result.value.contentHash.slice(0, 12) }, { revalidate: true });
  const s = await currentState();
  return NextResponse.json({ ok: true, ...result.value, ...after, state: s.ok ? s.state : null }, { headers: { "Cache-Control": "no-store" } });
}
