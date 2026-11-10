import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth/guard";
import { getPublicSiteStats } from "@/lib/data/public-stats";
import { getStructureCompany } from "@/lib/data/structure-company";
import { getState, isMissingTable, type CmsState } from "@/lib/site-content/store";
import { EditorCanvas } from "./EditorCanvas";

// The canvas inside the Super Admin visual editor. Server-checked here, never cached, never indexed. It is the one page that may
// be framed (same origin only: see next.config.ts), because the editor shows it in an iframe at the chosen device width.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Website editor canvas", robots: { index: false, follow: false, nocache: true } };

export default async function EditorCanvasPage() {
  await requireRole("SUPER_ADMIN");
  let state: CmsState;
  try {
    state = await getState("home");
  } catch (err) {
    if (isMissingTable(err)) redirect("/admin/website-content");
    throw err;
  }
  const [stats, structure] = await Promise.all([getPublicSiteStats(), getStructureCompany()]);
  const wire = stats.state === "ok" ? { ...stats, dataAsOf: stats.dataAsOf ? stats.dataAsOf.toISOString() : null } : stats;
  return <EditorCanvas initialContent={state.editing} stats={wire} structure={structure} />;
}
