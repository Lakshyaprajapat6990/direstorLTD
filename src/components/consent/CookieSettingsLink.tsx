"use client";

import { OPEN_SETTINGS_EVENT } from "@/lib/consent";

// The unobtrusive footer link that reopens the cookie settings.
export function CookieSettingsLink({ className }: { className?: string }) {
  return (
    <button type="button" onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS_EVENT))} className={className}>
      Cookie settings
    </button>
  );
}
