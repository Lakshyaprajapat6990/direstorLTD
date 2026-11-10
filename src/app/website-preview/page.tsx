import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { HomeView } from "@/components/marketing/HomeView";
import { PreviewCookieNotice } from "@/components/consent/PreviewCookieNotice";
import { getPublicSiteStats } from "@/lib/data/public-stats";
import { getStructureCompany } from "@/lib/data/structure-company";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { applyEditable } from "@/lib/site-content/schema";
import { getState, isMissingTable, type CmsState } from "@/lib/site-content/store";

// Super Admin draft preview. Server-checked here (the page is outside the signed-in app layout so it looks exactly like the
// public page, which also means the proxy does not cover it: the guard below is the protection). Never cached (it reads the
// session and the database on every request), never indexed, and it renders the SAVED draft, never anything unsaved.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Website preview", robots: { index: false, follow: false, nocache: true } };

export default async function WebsitePreview({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  await requireRole("SUPER_ADMIN");
  const { view } = await searchParams;
  const showPublished = view === "published";
  let state: CmsState;
  try {
    state = await getState("home");
  } catch (err) {
    if (isMissingTable(err)) redirect("/admin/website-content"); // that page explains the missing migration
    throw err;
  }
  const [stats, structure] = await Promise.all([getPublicSiteStats(), getStructureCompany()]);
  const editable = showPublished ? (state.published ?? state.defaults) : state.editing;
  const label = showPublished ? (state.published ? `published version ${state.publishedVersion}` : "the built-in wording (nothing published)") : state.editingSource === "draft" ? `the saved draft (version ${state.draftVersion})` : state.editingSource === "published" ? "the published content (no saved draft)" : "the built-in wording (no saved draft)";
  return (
    <>
      <div role="note" className="border-b border-amber-300 bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">
        <strong>Preview, not public.</strong> Showing {label}. Visible to Super Admins only.{" "}
        <a className="font-semibold underline" href={showPublished ? "/website-preview" : "/website-preview?view=published"}>
          {showPublished ? "Show the saved draft" : "Show what is published"}
        </a>{" "}
        · <a className="font-semibold underline" href="/admin/website-content">Back to Website Content</a>
      </div>
      <HomeView content={applyEditable(DEFAULT_SITE_CONTENT, editable)} stats={stats} structure={structure} />
      {/* The public cookie banner is not mounted in the preview; its footer "Cookie settings" link opens an explanation only. */}
      <PreviewCookieNotice />
    </>
  );
}
