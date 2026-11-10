import { BrandDot } from "@/components/brand/BrandDot";
import Link from "next/link";
import { CookieConsent } from "@/components/consent/CookieConsent";
import { CookieSettingsLink } from "@/components/consent/CookieSettingsLink";

// The frame for the public policy pages (/cookie-policy, /privacy-policy). Plain, readable, no authentication, in the site's navy /
// royal blue / white. The cookie banner is mounted here too, so "Cookie settings" works on these pages.
//
// Body copy is held to a readable line length (max-w-3xl); a section marked data-wide (the cookie table) may use the full width of the
// page. Navigation and footer links are real lists, so they stay separate items in every reader, copy/paste and text-only view.
export const POLICY_LAST_UPDATED = "26 October 2026";

const navLink = "rounded-sm focus-ring";

export function LegalPage({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-800">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-5 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 rounded-md focus-ring">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">DL</span>
            <span className="text-xl font-bold tracking-tight text-indigo-600">
              DIRECTOR<BrandDot />LTD
            </span>
          </Link>
          <nav aria-label="Site">
            <ul className="flex items-center gap-5 text-sm font-semibold">
              <li>
                <Link href="/" className={`${navLink} text-indigo-900 hover:text-indigo-600`}>
                  Home
                </Link>
              </li>
              <li>
                <Link href="/login" className={`${navLink} text-indigo-900 hover:text-indigo-600`}>
                  Sign in
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
        <h1 className="max-w-3xl text-3xl font-bold tracking-tight text-indigo-950 sm:text-4xl">{title}</h1>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-slate-600">{intro}</p>
        <p className="mt-2 text-sm text-slate-500">Last updated: {POLICY_LAST_UPDATED}</p>
        <div className="mt-8 space-y-9 text-[15px] leading-relaxed [&>*]:max-w-3xl [&>[data-wide]]:max-w-none [&_a]:font-semibold [&_a]:text-indigo-700 [&_a]:underline [&_a]:underline-offset-2 [&_h2]:mb-3 [&_h2]:scroll-mt-6 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:text-indigo-950 [&_li]:mt-1.5 [&_ul.prose-list]:list-disc [&_ul.prose-list]:pl-6">{children}</div>
      </main>

      <footer className="border-t border-slate-200 bg-indigo-950 text-blue-100">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-5 py-5 text-xs sm:flex-row sm:px-6">
          <p>© {new Date().getFullYear()} DIRECTOR.LTD</p>
          <nav aria-label="Legal">
            <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
              <li>
                <Link href="/cookie-policy" className={`${navLink} hover:text-white hover:underline`}>
                  Cookie policy
                </Link>
              </li>
              <li>
                <Link href="/privacy-policy" className={`${navLink} hover:text-white hover:underline`}>
                  Privacy policy
                </Link>
              </li>
              <li>
                <CookieSettingsLink className={`${navLink} hover:text-white hover:underline`} />
              </li>
            </ul>
          </nav>
        </div>
      </footer>
      <CookieConsent />
    </div>
  );
}
