"use client";

import { useState } from "react";
import Link from "next/link";
import { UserRound, X } from "lucide-react";

// A small, optional nudge on the customer dashboard. It never blocks anything. It is dismissed for the current visit only: nothing
// is written to cookies or browser storage (every storage key the app uses must be listed in the cookie policy), and it stops
// appearing for good as soon as any optional detail is saved (the server only renders it while the profile is empty).
export function CompleteProfilePrompt() {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <aside role="note" aria-label="Complete your profile" className="flex items-center gap-3 rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-sm text-slate-700">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-indigo-600 ring-1 ring-indigo-100">
        <UserRound className="h-4 w-4" aria-hidden="true" />
      </span>
      <p className="min-w-0 flex-1">
        <span className="font-semibold text-slate-900">Complete your profile.</span> <span className="text-slate-600">Add your details in Settings whenever you like. It is optional.</span>
      </p>
      <Link href="/settings#your-details" className="shrink-0 rounded-md px-2 py-1 text-sm font-semibold text-indigo-700 hover:bg-white focus-ring">
        Go to Settings
      </Link>
      <button type="button" aria-label="Dismiss" className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-white hover:text-slate-600 focus-ring" onClick={() => setVisible(false)}>
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </aside>
  );
}
