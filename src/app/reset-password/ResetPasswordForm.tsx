"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, TriangleAlert } from "lucide-react";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button } from "@/components/ui/Button";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";

type Phase = "reading" | "missing" | "form" | "invalid" | "done";

export function ResetPasswordForm() {
  const [phase, setPhase] = useState<Phase>("reading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirmPassword?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const token = useRef<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  // Read the secret from the URL fragment, keep it only in memory, and take it out of the address bar and history entry.
  // Idempotent on purpose: React may run an effect twice (development), and the second run must not find the address bar already
  // cleared and conclude there was no token.
  useEffect(() => {
    if (!token.current) {
      const m = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
      if (m) {
        token.current = m[1];
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
    setPhase(token.current ? "form" : "missing");
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setFormError(null);
    const local: typeof errors = {};
    if (!password) local.password = "Choose a password.";
    else if (password.length < MIN_PASSWORD_LENGTH) local.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (!local.password && password !== confirm) local.confirmPassword = "The passwords do not match.";
    else if (!confirm) local.confirmPassword = "Confirm your password.";
    setErrors(local);
    if (local.password || local.confirmPassword) {
      (local.password ? passwordRef : confirmRef).current?.focus();
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.current, password, confirmPassword: confirm }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        token.current = null;
        setPassword("");
        setConfirm("");
        setPhase("done");
        return;
      }
      if (data.code === "invalid_token") setPhase("invalid");
      else if (res.status === 400 && data.fieldErrors) {
        setErrors(data.fieldErrors);
        (data.fieldErrors.password ? passwordRef : confirmRef).current?.focus();
      } else setFormError(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setFormError("Could not reach the server. Please try again.");
    }
    setLoading(false);
  }

  if (phase === "reading") return <p className="text-sm text-slate-500">Checking your link…</p>;

  if (phase === "missing" || phase === "invalid") {
    return (
      <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <div className="flex items-center gap-2 text-amber-900">
          <TriangleAlert className="h-5 w-5 shrink-0" aria-hidden="true" />
          <h2 className="text-base font-semibold">{phase === "missing" ? "This link is incomplete" : "This link has expired or was already used"}</h2>
        </div>
        <p className="mt-3 text-sm text-slate-700">Reset links work once and expire after 30 minutes. Request a new one to continue.</p>
        <Link href="/forgot-password" className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus-ring">
          Request a new link
        </Link>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <div className="flex items-center gap-2 text-emerald-800">
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          <h2 className="text-base font-semibold">Your password has been changed</h2>
        </div>
        <p className="mt-3 text-sm text-slate-700">Sign in with your new password. You have been signed out everywhere else.</p>
        <Link href="/login" className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus-ring">
          Continue to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {formError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {formError}
        </div>
      )}
      <div>
        <label htmlFor="reset-password" className="mb-1.5 block text-xs font-medium text-slate-700">New password</label>
        <PasswordInput ref={passwordRef} id="reset-password" autoComplete="new-password" maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} disabled={loading} aria-invalid={errors.password ? true : undefined} aria-describedby={errors.password ? "reset-password-error" : "reset-password-hint"} />
        {errors.password && (
          <p id="reset-password-error" className="mt-1.5 text-xs text-red-600">
            {errors.password}
          </p>
        )}
        <p id="reset-password-hint" className="mt-1.5 text-xs text-slate-500">
          At least {MIN_PASSWORD_LENGTH} characters, mixing letters with numbers or symbols (or 16+ characters). Avoid common passwords, your name and your email name.
        </p>
      </div>
      <div>
        <label htmlFor="reset-confirm" className="mb-1.5 block text-xs font-medium text-slate-700">Confirm new password</label>
        <PasswordInput ref={confirmRef} id="reset-confirm" autoComplete="new-password" maxLength={200} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={loading} aria-invalid={errors.confirmPassword ? true : undefined} aria-describedby={errors.confirmPassword ? "reset-confirm-error" : undefined} />
        {errors.confirmPassword && (
          <p id="reset-confirm-error" className="mt-1.5 text-xs text-red-600">
            {errors.confirmPassword}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={loading}>
        {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {loading ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
