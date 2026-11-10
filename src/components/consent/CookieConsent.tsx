"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Cookie, Lock, X } from "lucide-react";
import { CONSENT_RESET_PARAM, OPEN_SETTINGS_EVENT, shouldResetConsent } from "@/lib/consent";
import { clearConsent, getConsentSnapshot, getServerConsentSnapshot, readConsent, subscribeConsent, writeConsent } from "./store";

// The public site's cookie banner and settings. It only offers choices for what the application really uses (see src/lib/consent.ts
// and the README): strictly necessary cookies (always on) and third-party video players (off until allowed). There are no analytics or
// advertising technologies, so none are listed. Rejecting never affects sign-in: the necessary cookies are not optional.
//
// When the banner shows: only while there is NO valid saved choice (none, malformed, another version, dated in the future, or expired).
// Opening the settings from the banner and closing them again changes nothing and the banner returns. A valid choice hides the banner
// until it expires or the policy version changes; the footer "Cookie settings" link reopens the settings at any time.
const BLOCKED = "Your browser is blocking cookies, so this choice cannot be remembered on this device. Allow cookies for this site in your browser settings and try again.";
// Reject (red) and Accept (green) are the same size, weight and shape on purpose: neither choice is made to look more attractive. White
// text on red-600 / green-700 is 4.8:1 / 5.0:1 or better. The focus ring is white because the banner is dark.
const choiceButton = "inline-flex min-h-10 items-center justify-center rounded-lg px-3.5 py-1.5 text-[13px] font-semibold text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white active:brightness-90 disabled:cursor-not-allowed disabled:opacity-60 md:min-h-9";
const rejectButton = `${choiceButton} bg-red-600 hover:bg-red-700`;
const acceptButton = `${choiceButton} bg-green-700 hover:bg-green-800`;

export function CookieConsent() {
  const raw = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getServerConsentSnapshot);
  const consent = readConsent(raw);
  const known = raw !== null;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [media, setMedia] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bannerRef = useRef<HTMLElement>(null);

  // Development only: /?reset-consent=1 forgets the saved choice (the consent cookie, nothing else) so the first-visit banner shows.
  useEffect(() => {
    if (!shouldResetConsent(window.location.search, process.env.NODE_ENV)) return;
    clearConsent();
    const url = new URL(window.location.href);
    url.searchParams.delete(CONSENT_RESET_PARAM);
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  // Always opens showing the CURRENT saved choice, whether it was opened from the banner or from the footer link.
  const openSettings = useCallback(() => {
    setMedia(readConsent(getConsentSnapshot())?.media ?? false);
    setError(null);
    setSettingsOpen(true);
  }, []);
  useEffect(() => {
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  }, [openSettings]);

  // Saved only if the browser really stored it; otherwise nothing is dismissed and the person is told.
  function choose(allowMedia: boolean) {
    if (!writeConsent(allowMedia)) {
      setError(BLOCKED);
      return;
    }
    setError(null);
    setSettingsOpen(false);
  }
  function closeSettings() {
    setError(null);
    setSettingsOpen(false); // no choice is made by closing
  }

  const showBanner = known && !consent && !settingsOpen;

  // The banner is fixed to the bottom of the screen. While it is showing, the page gets matching bottom padding so the footer and the
  // last lines of content can still be scrolled clear of it; it follows the banner's height as the screen is resized.
  useEffect(() => {
    const el = bannerRef.current;
    if (!showBanner || !el) return;
    const apply = () => {
      document.body.style.paddingBottom = `${Math.ceil(el.getBoundingClientRect().height) + 20}px`;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.body.style.paddingBottom = "";
    };
  }, [showBanner]);

  return (
    <>
      {showBanner && (
        <section
          ref={bannerRef}
          aria-label="Cookie consent"
          className="fixed inset-x-2 bottom-2 z-40 mx-auto max-w-5xl rounded-xl border border-white/20 bg-indigo-950/95 text-white shadow-xl shadow-indigo-950/30 supports-[backdrop-filter]:bg-indigo-950/85 supports-[backdrop-filter]:backdrop-blur-md sm:inset-x-4 sm:bottom-3"
        >
          <div className="flex flex-col gap-2.5 px-3.5 py-2.5 md:flex-row md:items-center md:gap-5">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <Cookie className="mt-0.5 h-4 w-4 shrink-0 text-sky-300" aria-hidden />
              <p className="text-xs leading-snug text-indigo-50 sm:text-[13px]">
                <strong className="font-semibold text-white">Cookies on DIRECTOR.LTD. </strong>
                We use strictly necessary cookies to keep you signed in and the site secure. YouTube or Vimeo videos only load if you allow them. We do not use advertising or analytics cookies.{" "}
                <Link href="/cookie-policy" className="whitespace-nowrap font-semibold text-white underline underline-offset-2 hover:text-sky-200 focus-ring">
                  Cookie policy
                </Link>
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2 md:flex-nowrap">
              <button type="button" onClick={openSettings} className="order-3 inline-flex min-h-10 w-full items-center justify-center rounded-lg px-3 py-1.5 text-[13px] font-semibold text-sky-200 underline underline-offset-2 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white md:order-1 md:min-h-9 md:w-auto">
                Cookie settings
              </button>
              <button type="button" onClick={() => choose(false)} className={`order-1 flex-1 md:order-2 md:flex-none ${rejectButton}`}>
                Reject non-essential
              </button>
              <button type="button" onClick={() => choose(true)} className={`order-2 flex-1 md:order-3 md:flex-none ${acceptButton}`}>
                Accept all
              </button>
            </div>
          </div>
          {error && (
            <p role="alert" className="mx-3.5 mb-2.5 rounded-lg bg-red-500/25 px-3 py-1.5 text-xs font-medium text-red-50 ring-1 ring-red-300/50">
              {error}
            </p>
          )}
        </section>
      )}
      {settingsOpen && <SettingsDialog media={media} setMedia={setMedia} error={error} onSave={() => choose(media)} onAccept={() => choose(true)} onReject={() => choose(false)} onClose={closeSettings} />}
    </>
  );
}

function SettingsDialog({ media, setMedia, error, onSave, onAccept, onReject, onClose }: { media: boolean; setMedia: (v: boolean) => void; error: string | null; onSave: () => void; onAccept: () => void; onReject: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // the page behind does not scroll while the dialog is open
    el?.querySelector<HTMLElement>("button, input")?.focus();
    const FOCUSABLE = "button:not([disabled]), input:not([disabled]), a[href]";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab" && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
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
  }, [onClose]);

  const modalButton = "inline-flex min-h-10 items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 active:brightness-90 disabled:cursor-not-allowed disabled:opacity-60";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="cookie-settings-title" aria-describedby="cookie-settings-desc" className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 id="cookie-settings-title" className="text-base font-semibold text-slate-900">
            Cookie settings
          </h2>
          <button type="button" onClick={onClose} aria-label="Close cookie settings" className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 focus-ring">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="space-y-4 px-5 py-4 text-sm text-slate-700">
          <p id="cookie-settings-desc" className="text-[13px] text-slate-600">
            Choose which optional technologies this site may use. Closing this window without saving changes nothing.
          </p>
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 font-semibold text-slate-900">
                <Lock className="h-4 w-4 text-indigo-600" aria-hidden /> Strictly necessary
              </h3>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">Always on</span>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-600">
              Needed for the site to work, so they cannot be switched off: the sign-in session cookie (keeps you signed in and protects your account), a short-lived cookie used only while a signed-in user connects a calendar, and the cookie that remembers this choice. Signed-in users&rsquo; browsers also hold a temporary note that carries a report filter between two pages until the tab is closed.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 id="media-label" className="font-semibold text-slate-900">
                Embedded videos (YouTube, Vimeo)
              </h3>
              <label className="relative inline-flex cursor-pointer items-center">
                <input type="checkbox" role="switch" aria-labelledby="media-label" checked={media} onChange={(e) => setMedia(e.target.checked)} className="peer sr-only" />
                <span className="h-6 w-11 rounded-full bg-slate-300 transition-colors peer-checked:bg-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500 peer-focus-visible:ring-offset-2" />
                <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-5" />
              </label>
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-600">
              Only used on a page where a video has been added. When allowed, the video player is loaded from YouTube or Vimeo, which may set their own cookies. When not allowed, the video is not loaded and a placeholder is shown.
            </p>
          </div>
          <p className="text-xs text-slate-500">
            There are no analytics, advertising or tracking cookies to switch on. You can change this choice at any time with the &ldquo;Cookie settings&rdquo; link at the bottom of the page. Details:{" "}
            <Link href="/cookie-policy" className="font-semibold text-indigo-700 underline underline-offset-2 focus-ring">
              Cookie policy
            </Link>{" "}
            and{" "}
            <Link href="/privacy-policy" className="font-semibold text-indigo-700 underline underline-offset-2 focus-ring">
              Privacy policy
            </Link>
            .
          </p>
          {error && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700 ring-1 ring-red-200">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:justify-end">
          <button type="button" onClick={onReject} className={`${modalButton} bg-red-600 hover:bg-red-700`}>
            Reject non-essential
          </button>
          <button type="button" onClick={onAccept} className={`${modalButton} bg-green-700 hover:bg-green-800`}>
            Accept all
          </button>
          <button type="button" onClick={onSave} className={`${modalButton} bg-indigo-600 hover:bg-indigo-700`}>
            Save choices
          </button>
        </div>
      </div>
    </div>
  );
}
