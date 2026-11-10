"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    if (!email.trim()) {
      setError("Enter your email address.");
      input.current?.focus();
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/forgot-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setSent(true);
      else {
        setError(data.error ?? "Something went wrong. Please try again.");
        input.current?.focus();
      }
    } catch {
      setError("Could not reach the server. Please try again.");
    }
    setLoading(false);
  }

  if (sent) {
    return (
      <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <div className="flex items-center gap-2 text-emerald-800">
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          <h2 className="text-base font-semibold">Check your email</h2>
        </div>
        <p className="mt-3 text-sm text-slate-700">If that address belongs to an account, an email with a link to reset the password will arrive shortly. The link works once and expires in 30 minutes.</p>
        <p className="mt-2 text-sm text-slate-600">Nothing after a few minutes? Check your spam folder, try again, or contact your administrator.</p>
        <Link href="/login" className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus-ring">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {error && (
        <div id="forgot-error" role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      <div>
        <label htmlFor="forgot-email" className="mb-1.5 block text-xs font-medium text-slate-700">Email address</label>
        <Input ref={input} id="forgot-email" type="email" autoComplete="email" inputMode="email" maxLength={254} placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={loading} aria-invalid={error ? true : undefined} aria-describedby={error ? "forgot-error" : undefined} />
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={loading}>
        {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {loading ? "Sending…" : "Email me a reset link"}
      </Button>
    </form>
  );
}
