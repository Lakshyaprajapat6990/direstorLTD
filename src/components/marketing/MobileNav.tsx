"use client";

import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";

// Section links for narrow screens (the desktop row in Header.tsx is hidden below the md breakpoint).
// A disclosure button, not a modal: focus stays on the button, Escape closes the menu and keeps focus there, choosing a link
// closes it, and it closes by itself if the window grows to the desktop layout. The panel is not rendered while closed, so
// its links are never in the tab order. Without JavaScript the button does nothing and the page's own sections still scroll.
export function MobileNav({ links }: { links: { href: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const mq = window.matchMedia("(min-width: 768px)");
    const onResize = () => mq.matches && setOpen(false);
    document.addEventListener("keydown", onKey);
    mq.addEventListener("change", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onResize);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="mobile-sections"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-300 text-indigo-900 hover:bg-slate-50 focus-ring md:hidden"
      >
        {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
        <span className="sr-only">{open ? "Close section menu" : "Open section menu"}</span>
      </button>
      {open && (
        <nav id="mobile-sections" aria-label="Sections (mobile)" className="absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-y-auto border-b border-slate-200 bg-white shadow-lg md:hidden">
          <ul className="mx-auto max-w-7xl px-6 py-2">
            {links.map((l) => (
              <li key={l.href}>
                <a href={l.href} onClick={() => setOpen(false)} className="block rounded-md py-3 text-base font-semibold text-indigo-900 hover:text-indigo-600 focus-ring">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </>
  );
}
