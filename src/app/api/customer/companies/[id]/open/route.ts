import { NextResponse } from "next/server";
import { requireCustomerApi } from "@/lib/customer/guard";
import { openCompany } from "@/lib/customer/free-tier";
import { logActivity } from "@/lib/activity";

// Spends one of the customer's free company views (or confirms the company was already opened). The only way a profile becomes
// readable for a customer: the profile page checks for the row this creates.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCustomerApi(request);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: "Company not found." }, { status: 404 });

  const result = await openCompany(auth.session.userId, id);
  if (!result.ok) {
    if (result.reason === "not_found") return NextResponse.json({ error: "Company not found." }, { status: 404 });
    return NextResponse.json({ error: "You have used all of your free company views.", usage: result.usage }, { status: 403 });
  }
  if (!result.alreadyOpened) await logActivity(auth.session, "customer_company_opened", { companyId: id });
  return NextResponse.json({ ok: true, alreadyOpened: result.alreadyOpened, usage: result.usage });
}
