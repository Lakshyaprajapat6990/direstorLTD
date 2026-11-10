"use client";

import { useState, useSyncExternalStore } from "react";
import { PlayCircle } from "lucide-react";
import { OPEN_SETTINGS_EVENT } from "@/lib/consent";
import { getConsentSnapshot, getServerConsentSnapshot, readConsent, subscribeConsent, writeConsent } from "./store";

// Holds back a third-party video player until the visitor has allowed embedded videos. The server-rendered HTML (and the first
// render in the browser) contains only the placeholder, so nothing is requested from YouTube or Vimeo before consent. The CMS editor canvas
// renders the same way, so what an editor sees is what a visitor who has not allowed videos sees. If the choice is later withdrawn, the
// player is removed from the page straight away (this component re-renders on every consent change).
export function ConsentGate({ provider, children }: { provider: string; children: React.ReactNode }) {
  const raw = useSyncExternalStore(subscribeConsent, getConsentSnapshot, getServerConsentSnapshot);
  const [blocked, setBlocked] = useState(false);
  const allowed = readConsent(raw)?.media === true;
  if (allowed) return <>{children}</>;
  const name = provider === "youtube" ? "YouTube" : provider === "vimeo" ? "Vimeo" : "an external site";
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-100 px-6 text-center">
      <PlayCircle className="h-9 w-9 text-slate-400" aria-hidden />
      <p className="max-w-sm text-sm text-slate-600">This video is hosted by {name}, which may set cookies. It is not loaded until you allow embedded videos.</p>
      {blocked && (
        <p role="alert" className="max-w-sm text-xs font-medium text-red-700">
          Your browser is blocking cookies, so this choice cannot be remembered. Allow cookies for this site and try again.
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <button type="button" onClick={() => setBlocked(!writeConsent(true))} className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-ring">
          Allow videos
        </button>
        <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT))} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-ring">
          Cookie settings
        </button>
      </div>
    </div>
  );
}
