import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/activity";
import { readMutationJson } from "@/lib/site-content/request";
import { validateProfile } from "@/lib/customer/profile";
import { loadProfile, saveProfile } from "@/lib/customer/profile-store";

// A customer reads and saves ONLY their own optional details: the target is always the signed-in user's id from the server-side
// session, never a value from the request. Staff accounts have no customer profile. Marketing choices are a separate endpoint.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "CUSTOMER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { values, phoneVerified } = await loadProfile(session.userId);
  return NextResponse.json({ values, phoneVerified }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "CUSTOMER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await readMutationJson(request);
  if (!body.ok) return body.response;
  if (typeof body.json !== "object" || body.json === null || Array.isArray(body.json)) return NextResponse.json({ error: "Check the form and try again." }, { status: 400 });

  const parsed = validateProfile(body.json as Record<string, unknown>);
  if (!parsed.ok) return NextResponse.json({ error: "Check the highlighted fields.", fieldErrors: parsed.errors }, { status: 400 });

  const { changed, smsWithdrawn } = await saveProfile(session.userId, parsed.value);
  // Field NAMES only: the values (address, phone) never go into the activity log.
  if (changed.length) await logActivity(session, "profile_updated", { meta: { fields: changed } });
  if (smsWithdrawn) await logActivity(session, "marketing_consent_changed", { meta: { channel: "sms", granted: false, source: "phone_removed" } });
  return NextResponse.json({ ok: true, values: parsed.value, smsConsentWithdrawn: smsWithdrawn }, { headers: { "Cache-Control": "no-store" } });
}
