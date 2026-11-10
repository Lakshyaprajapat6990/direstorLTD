import type { Metadata } from "next";
import { requireRole } from "@/lib/auth/guard";
import { Globe } from "lucide-react";
import { AdminTabs } from "@/components/admin/AdminTabs";
import { PageHero } from "@/components/admin/AdminUi";
import { getState, isMissingTable, type CmsState } from "@/lib/site-content/store";
import { VisualEditor } from "./VisualEditor";

export const metadata: Metadata = { title: "Website Content (CMS)" };
export const dynamic = "force-dynamic";

// Super Admin only (checked here on the server; the tab being hidden for others is not what protects this page).
export default async function WebsiteContentPage() {
  await requireRole("SUPER_ADMIN");
  let state: CmsState | null = null;
  try {
    state = await getState("home");
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }
  return (
    <div className="space-y-4">
      <AdminTabs active="content" />
      <PageHero icon={Globe} eyebrow="Super Admin" title="Website Content (CMS)" description="Click anything on your homepage to edit it, see the result straight away, and publish when you are happy. Live statistics, the API and ownership statements and sign-in destinations stay controlled in code." compact />
      {state ? (
        <VisualEditor initial={state} />
      ) : (
        <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Website Content is not set up in this database yet: the migration that creates its tables has not been applied. The public homepage is unaffected and shows its built-in content.
        </p>
      )}
    </div>
  );
}
