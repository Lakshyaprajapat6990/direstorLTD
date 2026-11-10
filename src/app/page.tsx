import { HomeView } from "@/components/marketing/HomeView";
import { CookieConsent } from "@/components/consent/CookieConsent";
import { getPublicSiteStats } from "@/lib/data/public-stats";
import { getStructureCompany } from "@/lib/data/structure-company";
import { getPublishedSiteContent } from "@/lib/site-content/reader";

// Register figures come from the database through getPublicSiteStats (the dashboard's own calculation, memoised for five
// minutes). The page is prerendered at build and then regenerated at most every 60 seconds, so a figure can be a few
// minutes old and a fresh deploy can briefly serve the build-time render. When the figures cannot be read, or the register
// is empty, the page shows "—" and a notice instead of a number. Published website content is read in the same render
// (getPublishedSiteContent: built-in defaults when there is none or it cannot be read), so a publish becomes visible on the next
// regeneration, sooner when the publish route calls revalidatePath("/").
export const revalidate = 60;

export default async function Home() {
  const [stats, content, structure] = await Promise.all([getPublicSiteStats(), getPublishedSiteContent(), getStructureCompany()]);
  // The consent banner lives here, on the public route only, so the CMS editor canvas and draft preview (which render HomeView) never show it.
  return (
    <>
      <HomeView content={content} stats={stats} structure={structure} />
      <CookieConsent />
    </>
  );
}
