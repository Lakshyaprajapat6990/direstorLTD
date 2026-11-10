import { BrandDot } from "@/components/brand/BrandDot";
import Link from "next/link";
import { LinkButton } from "@/components/ui/Button";
import { MobileNav } from "./MobileNav";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@/lib/site-content/defaults";
import { noEd, type Ed } from "./cms-edit";

// Two rows like a data-platform site: brand + actions, then the section navigation.
// `content` defaults to the built-in copy; a caller may pass validated content of the same shape.
export function MarketingHeader({ content = DEFAULT_SITE_CONTENT.header, ed = noEd }: { content?: SiteContent["header"]; ed?: Ed }) {
  // The link to the removed API section is not shown. Stored content keeps one label per default link (by position), so the
  // entry stays in the list and is skipped here; the remaining links keep their original positions for the editor.
  const links = content.links;
  const shown = links.filter((l) => l.href !== "#api");
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-md focus-ring">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">DL</span>
          <span className="text-xl font-bold tracking-tight text-indigo-600">
            DIRECTOR<BrandDot />LTD
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <LinkButton href="/login" size="md">
            Sign in
          </LinkButton>
          <div className="hidden lg:block">
            <LinkButton href="/register" variant="outline" size="md">
              Free account
            </LinkButton>
          </div>
          {/* The wrapper hides it on narrow screens: LinkButton's own inline-flex would beat a `hidden` class on the link itself. */}
          <div className="hidden sm:block">
            <LinkButton href="#uk-data" variant="outline" size="md">
              Explore UK data
            </LinkButton>
          </div>
          <MobileNav links={shown} />
        </div>
      </div>
      <nav className="mx-auto hidden h-11 max-w-7xl items-center gap-9 px-6 md:flex" aria-label="Sections">
        {links.map((l, i) =>
          l.href === "#api" ? null : (
          <a key={l.href} href={l.href} className="rounded-sm text-[15px] font-semibold text-indigo-900 hover:text-indigo-600 focus-ring" {...ed(`header.links.${i}.label`)}>
            {l.label}
          </a>
          )
        )}
      </nav>
    </header>
  );
}
