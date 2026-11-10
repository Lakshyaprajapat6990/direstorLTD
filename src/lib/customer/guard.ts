import { NextResponse } from "next/server";
import { getSession, type SessionPayload } from "@/lib/auth/session";
import { isJsonContentType, isSameOrigin } from "@/lib/site-content/request";

// Guard for the free-customer API. The identity and role come from the verified session (the database row), never from the
// request. Staff and Super Admin accounts are refused too: they use the real company tools, and a quota that applied to them
// (or that they could spend on a customer's behalf) would be wrong.
export async function requireCustomerApi(request: Request): Promise<{ session: SessionPayload } | { error: NextResponse }> {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (session.role !== "CUSTOMER") return { error: NextResponse.json({ error: "This is only available to free customer accounts." }, { status: 403 }) };
  if (!isSameOrigin(request)) return { error: NextResponse.json({ error: "Request not allowed." }, { status: 403 }) };
  if (request.method !== "GET" && !isJsonContentType(request)) return { error: NextResponse.json({ error: "Send the request as JSON." }, { status: 415 }) };
  return { session };
}
