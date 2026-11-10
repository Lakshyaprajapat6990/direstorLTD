"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { CONSENT_CHANNELS, CONSENT_VERSION, CONSENT_WORDING, type ConsentChannel } from "@/lib/customer/consent-text";
import type { ConsentHistoryItem, ConsentState } from "@/lib/customer/profile-store";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

// Optional marketing permissions: one unticked-by-default box per channel, changed only by an explicit click and applied at once.
export function MarketingPreferencesClient({ initial, history: initialHistory, hasPhone: initialHasPhone }: { initial: ConsentState; history: ConsentHistoryItem[]; hasPhone: boolean }) {
  const [state, setState] = useState(initial);
  const [history, setHistory] = useState(initialHistory);
  const [hasPhone, setHasPhone] = useState(initialHasPhone);
  const [busy, setBusy] = useState<ConsentChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/profile/consent", { cache: "no-store" }).catch(() => null);
    if (r?.ok) {
      const d = await r.json();
      setState(d.state);
      setHistory(d.history);
    }
  }, []);

  // Saving the details form can change the phone number (and withdraws SMS marketing if it is removed); pick that up without a reload.
  useEffect(() => {
    const on = async (e: Event) => {
      setHasPhone(!!(e as CustomEvent<{ hasPhone: boolean }>).detail?.hasPhone);
      await refresh();
    };
    window.addEventListener("dl-details-saved", on);
    return () => window.removeEventListener("dl-details-saved", on);
  }, [refresh]);

  async function change(channel: ConsentChannel, granted: boolean) {
    setBusy(channel);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/profile/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel, granted }) });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setState(d.state);
        setHistory(d.history);
        setNotice(`${CONSENT_WORDING[channel].label} ${granted ? "allowed" : "withdrawn"}.`);
      } else setError(d.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Could not reach the server. Please try again.");
    }
    setBusy(null);
  }

  return (
    <div className="space-y-4 p-4 sm:px-6 sm:py-5">
      <div className="space-y-1 text-[13px] leading-relaxed text-slate-600">
        <p>
          These choices are <strong className="font-semibold text-slate-800">optional</strong> and are off unless you turn them on. You do not need to allow either to use your account. Running your account (signing in, your free
          allowance, password resets) does not depend on them.
        </p>
        <p>If you allow a channel, DIRECTOR.LTD may use it to tell you about its products, features and services. You can withdraw at any time here, as easily as you gave it.</p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CONSENT_CHANNELS.map((c) => {
          const st = state[c];
          const needsPhone = c === "sms" && !hasPhone && !st.granted;
          return (
            <li key={c} className={`rounded-xl border p-3.5 shadow-sm transition-colors ${st.granted ? "border-emerald-300 bg-emerald-50/50" : needsPhone ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white hover:border-slate-300"}`}>
              <label className={`flex items-start gap-3 ${needsPhone ? "cursor-not-allowed" : "cursor-pointer"}`}>
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 accent-blue-600 focus-ring disabled:cursor-not-allowed"
                  checked={st.granted}
                  disabled={busy !== null || needsPhone}
                  onChange={(e) => change(c, e.target.checked)}
                  aria-describedby={needsPhone ? `consent-${c}-needs-phone consent-${c}-status` : `consent-${c}-status`}
                />
                <span className="text-[13px] text-slate-800">
                  <span className="block text-sm font-semibold">{CONSENT_WORDING[c].label}</span>
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-slate-600">{CONSENT_WORDING[c].statement}</span>
                </span>
                {busy === c && <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-slate-400" aria-hidden="true" />}
              </label>
              {needsPhone && (
                <div id={`consent-${c}-needs-phone`} className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] leading-snug text-amber-900">
                  <span className="min-w-0 basis-full sm:flex-1 sm:basis-0">This box is switched off until you save a phone number. Add one in Your details above, then come back here to turn it on.</span>
                  <button
                    type="button"
                    className="shrink-0 rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-300 hover:bg-amber-100 focus-ring"
                    onClick={() => {
                      const field = document.getElementById("details-phone");
                      field?.scrollIntoView({ behavior: "smooth", block: "center" });
                      field?.focus({ preventScroll: true });
                    }}
                  >
                    Add a phone number
                  </button>
                </div>
              )}
              <p id={`consent-${c}-status`} className={`mt-2.5 border-t pt-2 pl-7 text-[11.5px] ${st.granted ? "border-emerald-100 font-medium text-emerald-800" : "border-slate-100 text-slate-500"}`} suppressHydrationWarning>
                {st.granted ? `Allowed on ${when(st.at!)}.` : st.at ? `Withdrawn on ${when(st.at)}.` : "Not allowed (you have never turned this on)."}              </p>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-slate-500">Text-message marketing has nothing to do with signing in: allowing or withdrawing it never changes how you sign in, and allowing marketing texts does not verify your number for anything.</p>
      <p className="text-xs text-slate-500">Draft wording (version {CONSENT_VERSION}), not yet reviewed by a legal adviser. Each choice is saved with the wording and version shown here.</p>

      {history.length > 0 && (
        <details className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium text-slate-700 focus-ring">Your history of choices ({history.length})</summary>
          <ul className="mt-3 space-y-1.5 text-xs text-slate-600">
            {history.map((h, i) => (
              <li key={i} suppressHydrationWarning>
                {when(h.at)} — {CONSENT_WORDING[h.channel].label}: <strong>{h.granted ? "allowed" : "withdrawn"}</strong>
                {h.source === "phone_removed" ? " (phone number removed)" : ""} · wording version {h.version}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
