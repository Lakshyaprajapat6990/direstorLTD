"use client";

import { useEffect, useState, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { BoxAlign } from "@/lib/site-content/styles";

// Small form controls shared by the appearance panels (buttons, headings, sections, images). Each one edits a single bounded value
// and reports `undefined` for "back to the default", so an untouched setting is never stored.

export const labelCls = "block text-xs font-semibold uppercase tracking-wide text-slate-500";
export const selectCls = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-ring";

export function SelectField<T extends string>({ id, label, value, options, onChange, defaultLabel = "Default" }: { id: string; label: string; value: T | undefined; options: readonly { value: T; label: string }[]; onChange: (v: T | undefined) => void; defaultLabel?: string }) {
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <select id={id} value={value ?? ""} onChange={(e) => onChange((e.target.value || undefined) as T | undefined)} className={selectCls}>
        <option value="">{defaultLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// A whole-number box with a range. Typing is free; the value is only reported when it is inside the range (otherwise the message
// says what the range is and the stored value stays as it was). Empty means "default".
export function NumberField({ id, label, value, min, max, step = 1, unit = "px", placeholder = "Auto", onChange, hint }: { id: string; label: string; value: number | undefined; min: number; max: number; step?: number; unit?: string; placeholder?: string; onChange: (v: number | undefined) => void; hint?: string }) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value === undefined ? "" : String(value));
    setError(null);
  }, [value]);
  const commit = (raw: string) => {
    setDraft(raw);
    if (raw.trim() === "") {
      setError(null);
      return onChange(undefined);
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return setError(`Enter a whole number from ${min} to ${max}.`);
    setError(null);
    onChange(n);
  };
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
      </label>
      <div className="mt-1 flex items-center gap-1.5">
        <input id={id} type="number" inputMode="numeric" min={min} max={max} step={step} value={draft} placeholder={placeholder} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} onChange={(e) => commit(e.target.value)} className={cn("w-full rounded-lg border px-3 py-2 text-sm focus-ring", error ? "border-red-400" : "border-slate-300")} />
        <span className="text-xs text-slate-400">{unit}</span>
      </div>
      {error ? (
        <p id={`${id}-err`} role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>
      )}
    </div>
  );
}

export function AlignButtons({ label, value, onChange, testId }: { label: string; value: BoxAlign | undefined; onChange: (v: BoxAlign | undefined) => void; testId?: string }) {
  const items = [
    { v: "left", Icon: AlignLeft, text: "Left" },
    { v: "center", Icon: AlignCenter, text: "Centre" },
    { v: "right", Icon: AlignRight, text: "Right" },
  ] as const;
  return (
    <div>
      <span className={labelCls} id={`${testId ?? label}-lbl`}>
        {label}
      </span>
      <div role="group" aria-labelledby={`${testId ?? label}-lbl`} data-testid={testId} className="mt-1 inline-flex gap-1 rounded-lg bg-slate-100 p-1">
        {items.map(({ v, Icon, text }) => (
          <button key={v} type="button" title={text} aria-label={text} aria-pressed={value === v} onClick={() => onChange(value === v ? undefined : v)} className={cn("flex h-8 w-9 items-center justify-center rounded-md focus-ring", value === v ? "bg-white text-indigo-700 shadow-sm" : "text-slate-600 hover:text-slate-900")}>
            <Icon className="h-4 w-4" aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}

export function Group({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group rounded-lg border border-slate-200">
      <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-sm font-semibold text-slate-800 focus-ring">{title}</summary>
      <div className="space-y-3 border-t border-slate-100 p-3">{children}</div>
    </details>
  );
}

export function Check({ id, label, checked, onChange, hint }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-2 text-sm text-slate-800">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300 focus-ring" />
        {label}
      </label>
      {hint && <p className="ml-6 mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}
