import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/activity";
import { readMutationJson } from "@/lib/site-content/request";
import { isConsentChannel } from "@/lib/customer/consent-text";
import { loadConsent, setConsent } from "@/lib/customer/profile-store";

// Marketing permissions of the signed-in customer, one channel at a time. Optional, never required for the account, and changed
// only by an explicit request here (saving the details form cannot alter them).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "CUSTOMER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await loadConsent(session.userId), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "CUSTOMER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await readMutationJson(request);
  if (!body.ok) return body.response;
  const b = body.json as { channel?: unknown; granted?: unknown } | null;
  if (!b || typeof b !== "object" || !isConsentChannel(b.channel) || typeof b.granted !== "boolean") return NextResponse.json({ error: "Choose a channel and whether to allow it." }, { status: 400 });

  const r = await setConsent(session.userId, b.channel, b.granted);
  if (!r.ok) return NextResponse.json({ error: "Add and save a phone number in your details before allowing text messages." }, { status: 409 });
  if (r.changed) await logActivity(session, "marketing_consent_changed", { meta: { channel: b.channel, granted: b.granted, source: "settings" } });
  return NextResponse.json({ ok: true, ...(await loadConsent(session.userId)) }, { headers: { "Cache-Control": "no-store" } });
}
