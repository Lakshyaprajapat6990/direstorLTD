import { notFound, redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/guard";

// Phase One: the limited free-account company page (and its 10-view quota) is retired. An old link goes to the full company page,
// which applies the normal permissions and data scope.
export default async function FreeCompanyPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) notFound();
  redirect(`/companies/${id}`);
}
