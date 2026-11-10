"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/Input";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button } from "@/components/ui/Button";
import { NumericCaptcha } from "@/components/auth/NumericCaptcha";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { validateRegistration, type RegistrationErrors, type RegistrationField } from "@/lib/auth/registration";

const FIELD_ORDER: RegistrationField[] = ["name", "email", "password", "confirmPassword"];
const labelClass = "mb-1.5 block text-xs font-medium text-slate-700";
const errorClass = "mt-1.5 text-xs text-red-600";

export function RegisterForm() {
  const [captcha, setCaptcha] = useState<{ ticket: string | null; answer: string }>({ ticket: null, answer: "" });
  const [captchaError, setCaptchaError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [values, setValues] = useState<Record<RegistrationField, string>>({ name: "", email: "", password: "", confirmPassword: "" });
  const [errors, setErrors] = useState<RegistrationErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const set = (field: RegistrationField) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  function focusFirstError(errs: RegistrationErrors) {
    const first = FIELD_ORDER.find((f) => errs[f]);
    if (first) document.getElementById(`register-${first}`)?.focus();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (loading) return;
    setFormError(null);

    const local = validateRegistration(values);
    if (!local.ok) {
      setErrors(local.errors);
      focusFirstError(local.errors);
      return;
    }
    setErrors({});
    if (!captcha.ticket || !captcha.answer.trim()) {
      setCaptchaError("Please type the number shown in the security check.");
      return;
    }
    setCaptchaError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...values, captchaToken: captcha.ticket, captchaAnswer: captcha.answer }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setDone(true);
        setTimeout(() => document.getElementById("register-success-heading")?.focus(), 0);
        return;
      }
      if (res.status === 400 && data.fieldErrors) {
        setErrors(data.fieldErrors);
        focusFirstError(data.fieldErrors);
      } else if (data.captcha) {
        setCaptchaError(data.error);
      } else {
        setFormError(data.error ?? "Something went wrong. Please try again.");
      }
    } catch {
      setFormError("Could not reach the server. Please try again.");
    }
    // A challenge works once; whatever went wrong, show a fresh one before the next attempt.
    setResetSignal((n) => n + 1);
    setCaptcha({ ticket: null, answer: "" });
    setLoading(false);
  }

  if (done) {
    return (
      <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <div className="flex items-center gap-2 text-emerald-800">
          <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
          <h2 id="register-success-heading" tabIndex={-1} className="text-base font-semibold outline-none">
            Your free account is ready
          </h2>
        </div>
        <p className="mt-3 text-sm text-slate-700">
          Sign in with the email address and password you just chose. No email is sent to confirm your address.
        </p>
        <p className="mt-2 text-sm text-slate-600">If that address already had an account, sign in with its existing password.</p>
        <Link href="/login" className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus-ring">
          Continue to sign in
        </Link>
      </div>
    );
  }

  const field = (f: RegistrationField) => ({
    id: `register-${f}`,
    value: values[f],
    onChange: set(f),
    "aria-invalid": errors[f] ? true : undefined,
    "aria-describedby": errors[f] ? `register-${f}-error` : f === "password" ? "register-password-hint" : undefined,
    disabled: loading,
  });
  const fieldError = (f: RegistrationField) =>
    errors[f] ? (
      <p id={`register-${f}-error`} className={errorClass}>
        {errors[f]}
      </p>
    ) : null;

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {formError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {formError}
        </div>
      )}
      <div>
        <label htmlFor="register-name" className={labelClass}>Full name</label>
        <Input type="text" autoComplete="name" maxLength={100} placeholder="Jane Smith" {...field("name")} />
        {fieldError("name")}
      </div>
      <div>
        <label htmlFor="register-email" className={labelClass}>Email address</label>
        <Input type="email" autoComplete="email" inputMode="email" maxLength={254} placeholder="you@company.com" {...field("email")} />
        {fieldError("email")}
      </div>
      <div>
        <label htmlFor="register-password" className={labelClass}>Password</label>
        <PasswordInput autoComplete="new-password" maxLength={200} {...field("password")} />
        {fieldError("password")}
        <p id="register-password-hint" className="mt-1.5 text-xs text-slate-500">
          At least {MIN_PASSWORD_LENGTH} characters, mixing letters with numbers or symbols (or 16+ characters). Avoid common passwords and your email name.
        </p>
      </div>
      <div>
        <label htmlFor="register-confirmPassword" className={labelClass}>Confirm password</label>
        <PasswordInput autoComplete="new-password" maxLength={200} {...field("confirmPassword")} />
        {fieldError("confirmPassword")}
      </div>
      <NumericCaptcha resetSignal={resetSignal} onChange={(v) => { setCaptcha(v); if (v.answer && captchaError) setCaptchaError(null); }} disabled={loading} error={captchaError} />
      <Button type="submit" size="lg" className="w-full" disabled={loading}>
        {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {loading ? "Creating account…" : "Create free account"}
      </Button>
      <p className="text-xs text-slate-500">
        We store your name and email address to run your account. Your account is free and does not include staff or administrator access. See the <Link href="/privacy-policy" className="font-semibold text-indigo-700 underline underline-offset-2 focus-ring">Privacy policy</Link>.
      </p>
    </form>
  );
}
