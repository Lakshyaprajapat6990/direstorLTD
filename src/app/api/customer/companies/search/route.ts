import { NextResponse } from "next/server";
import { requireCustomerApi } from "@/lib/customer/guard";
import { FREE_SEARCH_MIN_CHARS, freeSearchBlocked, freeSearchTerm, getFreeUsage, searchForFreeCustomer } from "@/lib/customer/free-tier";

// Free customer company search: name or company number, first 10 matches, identity fields only. See lib/customer/free-tier.ts.
export async function POST(request: Request) {
  const auth = await requireCustomerApi(request);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const term = freeSearchTerm(body && typeof body === "object" ? (body as { q?: unknown }).q : undefined);
  if (!term) return NextResponse.json({ error: `Enter at least ${FREE_SEARCH_MIN_CHARS} characters of a company name, or a company number.` }, { status: 400 });

  if (await freeSearchBlocked(auth.session.userId)) {
    return NextResponse.json({ error: "You are searching too quickly. Please wait a few minutes and try again." }, { status: 429, headers: { "Retry-After": "300" } });
  }

  const [rows, usage] = await Promise.all([searchForFreeCustomer(term), getFreeUsage(auth.session.userId)]);
  return NextResponse.json({ rows, usage });
}
