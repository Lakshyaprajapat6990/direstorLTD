import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/guard";

// Phase One: the limited free-account search is retired. Every signed-in account uses the full company tools, so an old link or
// bookmark to this page (with or without ?q=) lands on UK Companies with the same words.
export default async function FindCompaniesPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requireSession();
  const { q } = await searchParams;
  const term = (Array.isArray(q) ? q[0] : q)?.slice(0, 100).trim();
  redirect(term ? `/companies?q=${encodeURIComponent(term)}` : "/companies");
}
