import { NextResponse } from "next/server";
import { getSession, type SessionPayload } from "@/lib/auth/session";

// Server-side authorisation for every Website Content API handler. Website Content is SUPER_ADMIN only and deliberately has
// NO permission key: the permission catalogue's legacy ADMIN default grants every key, so a key would leak to ADMIN accounts.
//
// getSession() is the single source of truth (it checks the signed cookie, the UserSession row and that the user is still
// active, and resolves the role from the database, never from the cookie). This mirrors requireSuperAdminApi() in
// src/lib/columns/api.ts; it is a separate function only because that one's 403 text is specific to column settings.
// Pages use requireRole("SUPER_ADMIN") from src/lib/auth/guard.ts. Every handler and page calls its guard itself: hiding the
// tab or relying on the proxy is not authorisation.
export async function requireSuperAdminForCms(): Promise<{ session: SessionPayload } | { error: NextResponse }> {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (session.role !== "SUPER_ADMIN") return { error: NextResponse.json({ error: "Only a Super Admin can manage website content." }, { status: 403 }) };
  return { session };
}
