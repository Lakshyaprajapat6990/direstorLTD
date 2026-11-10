import { NextResponse } from "next/server";
import { requireSuperAdminForCms } from "@/lib/site-content/guard";
import { currentState } from "@/lib/site-content/route-helpers";

// Super Admin only. The current draft/published state and the revision history, for the Website Content screen.
export async function GET() {
  const auth = await requireSuperAdminForCms();
  if ("error" in auth) return auth.error;
  const s = await currentState();
  if (!s.ok) return s.response;
  return NextResponse.json({ state: s.state }, { headers: { "Cache-Control": "no-store" } });
}
