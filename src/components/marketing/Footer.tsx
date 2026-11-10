import { BrandDot } from "@/components/brand/BrandDot";
import Link from "next/link";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@/lib/site-content/defaults";
import { noEd, type Ed } from "./cms-edit";
import { CookieSettingsLink } from "@/components/consent/CookieSettingsLink";

// The footer is dark navy: a light, explicit ring keeps keyboard focus visible there in every browser.
const FOCUS_ON_DARK = "rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

// `content` defaults to the built-in copy; a caller may pass validated content of the same shape.
export function MarketingFooter({ content = DEFAULT_SITE_CONTENT.footer, ed = noEd }: { content?: SiteContent["footer"]; ed?: Ed }) {
  const cols: { title: string; links: [string, string][] }[] = [
    // The link to the removed API section is not shown; the entry keeps its position so the editor's link indexes stay valid.
    { title: content.sectionsTitle, links: content.links.map((l): [string, string] => [l.label, l.href]) },
  ];
  return (
    <footer className="bg-indigo-950 text-blue-100">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-14 md:grid-cols-[1.4fr_1fr]">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-sm font-bold text-indigo-900">DL</span>
            <span className="text-xl font-bold text-white">DIRECTOR<BrandDot />LTD</span>
          </div>
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-blue-200" {...ed("footer.tagline")}>{content.tagline}</p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <p className="text-xs font-semibold uppercase tracking-widest text-blue-300" {...ed("footer.sectionsTitle")}>{c.title}</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {c.links.map(([label, href], i) =>
                href === "#api" ? null : (
                <li key={label}>
                  {href.startsWith("#") ? (
                    <a href={href} className={`hover:text-white ${FOCUS_ON_DARK}`} {...ed(`footer.links.${i}.label`)}>{label}</a>
                  ) : (
                    <Link href={href} className={`hover:text-white ${FOCUS_ON_DARK}`} {...ed(`footer.links.${i}.label`)}>{label}</Link>
                  )}
                </li>
                )
              )}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-6 py-5 text-xs text-blue-300 sm:flex-row">
          <p>© {new Date().getFullYear()} DIRECTOR.LTD. Contains public sector information from Companies House, licensed under the Open Government Licence.</p>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            <Link href="/cookie-policy" className={`text-blue-200 hover:text-white hover:underline ${FOCUS_ON_DARK}`}>Cookie policy</Link>
            <Link href="/privacy-policy" className={`text-blue-200 hover:text-white hover:underline ${FOCUS_ON_DARK}`}>Privacy policy</Link>
            <CookieSettingsLink className={`text-blue-200 hover:text-white hover:underline ${FOCUS_ON_DARK}`} />
            <Link href="/login" className={`font-semibold text-white hover:underline ${FOCUS_ON_DARK}`}>Sign in →</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
