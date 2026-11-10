"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/Input";

type Loaded = { key: string; image: string | null; ticket: string | null; error: string | null };

// Numeric CAPTCHA field for the registration form. It only fetches a challenge and reports the ticket and what was typed; the
// server decides whether the answer is right. A challenge works once, so a new `resetSignal` (after a failed attempt) or a click
// on "New number" fetches a fresh one and clears what was typed.
export function NumericCaptcha({ resetSignal, onChange, disabled, error }: { resetSignal: number; onChange: (v: { ticket: string | null; answer: string }) => void; disabled?: boolean; error?: string | null }) {
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [typed, setTyped] = useState<{ key: string; value: string }>({ key: "", value: "" });
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const key = `${resetSignal}:${refresh}`;
  const loading = loaded?.key !== key;
  const answer = typed.key === key ? typed.value : "";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let next: Loaded;
      try {
        const res = await fetch("/api/auth/captcha", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        next = res.ok && data.ticket && data.image ? { key, image: data.image, ticket: data.ticket, error: null } : { key, image: null, ticket: null, error: data.error ?? "The security check could not be loaded. Please try again." };
      } catch {
        next = { key, image: null, ticket: null, error: "Could not reach the server. Please try again." };
      }
      if (cancelled) return;
      setLoaded(next);
      onChangeRef.current({ ticket: next.ticket, answer: "" });
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  const ready = !loading && !!loaded?.ticket;
  const message = error ?? (!loading ? loaded?.error : null) ?? null;

  return (
    <div>
      <label htmlFor="register-captcha" className="mb-1.5 block text-xs font-medium text-slate-700">
        Security check
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-14 w-[190px] max-w-full shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-indigo-50">
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-label="Loading security check" />
          ) : loaded?.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={loaded.image} alt="Security check number. Type the digits you see." width={190} height={56} className="h-full w-full select-none" draggable={false} />
          ) : null}
        </div>
        <button
          type="button"
          disabled={disabled || loading}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 focus-ring disabled:opacity-50"
          onClick={() => {
            onChangeRef.current({ ticket: null, answer: "" });
            setRefresh((n) => n + 1);
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> New number
        </button>
      </div>
      <Input
        id="register-captcha"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        pattern="[0-9]*"
        maxLength={8}
        placeholder="Type the number above"
        className="mt-2"
        value={answer}
        disabled={disabled || !ready}
        aria-invalid={message ? true : undefined}
        aria-describedby={message ? "register-captcha-error" : undefined}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "");
          setTyped({ key, value: v });
          onChange({ ticket: loaded?.ticket ?? null, answer: v });
        }}
      />
      {message && (
        <p id="register-captcha-error" role="alert" className="mt-1.5 text-xs text-red-600">
          {message}
        </p>
      )}
    </div>
  );
}
