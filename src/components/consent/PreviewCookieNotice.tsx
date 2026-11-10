"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Cookie, X } from "lucide-react";
import { OPEN_SETTINGS_EVENT } from "@/lib/consent";

// What the footer's "Cookie settings" link does inside the Super Admin draft preview (/website-preview). The public cookie banner is
// deliberately not mounted there, so without this the link did nothing. This dialog only EXPLAINS: it never reads, writes or clears
// the real consent cookie, sets no cookie or storage of its own, and loads nothing. The real choice stays untouched and is changed
// on the public site (or on the Cookie policy page).
export function PreviewCookieNotice() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_SETTINGS_EVENT, show);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, show);
  }, []);

  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    el?.querySelector<HTMLElement>("button")?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, close]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="preview-cookie-title" aria-describedby="preview-cookie-desc" className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 id="preview-cookie-title" className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <Cookie className="h-4 w-4 text-indigo-600" aria-hidden /> Cookie settings (preview)
          </h2>
          <button type="button" onClick={close} aria-label="Close" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 focus-ring">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div id="preview-cookie-desc" className="space-y-3 px-5 py-4 text-[13px] leading-relaxed text-slate-600">
          <p>
            On the public website this link opens the visitor&rsquo;s cookie settings, where embedded YouTube and Vimeo videos can be allowed or blocked. This preview is for Super Admins only, so the cookie banner is not shown here and nothing on this page can change a cookie choice.
          </p>
          <p>Your own saved cookie choice is not read, changed or removed by this preview.</p>
        </div>
        <div className="flex flex-col gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:justify-end">
          <a href="/cookie-policy" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-ring">
            Open the Cookie policy
          </a>
          <button type="button" onClick={close} className="inline-flex min-h-10 items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-ring">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
