"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, ChevronDown, Loader2, Pencil } from "lucide-react";
import { Input, Select } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { DEFAULT_COUNTRY, PROFILE_FIELDS, TITLES, type ProfileErrors, type ProfileField, type ProfileValues } from "@/lib/customer/profile";

const labelClass = "mb-1.5 block text-[12.5px] font-semibold leading-none text-slate-700";
const controlClass = "h-[38px] rounded-lg py-0 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition-colors hover:border-slate-400 focus:border-blue-600 disabled:bg-slate-50 disabled:text-slate-500";
// Each column (and so each input) is at most FIELD_MAX px wide; the two columns plus the gap make the form's content width.
// The wrapper below centres that block inside the card; on narrow screens it simply shrinks and the columns stay equal.
const FIELD_MAX = 280;
const errorClass = "mt-1 text-xs text-red-600";
// Same order as the fields appear on screen, so a validation error focuses the first one the customer can see.
const FIELD_ORDER: ProfileField[] = ["title", "firstName", "middleName", "surname", "businessName", "phone", "address1", "address2", "address3", "town", "state", "country", "postcode"];

// What each field is called on screen, in the order a customer reads them (the same order as the form).
const VIEW_ROWS: { group: string; fields: { f: ProfileField; label: string }[] }[] = [
  {
    group: "About you",
    fields: [
      { f: "title", label: "Title" },
      { f: "firstName", label: "First name" },
      { f: "middleName", label: "Middle name" },
      { f: "surname", label: "Last name" },
      { f: "businessName", label: "Business name" },
      { f: "phone", label: "Phone number" },
    ],
  },
  {
    group: "Address",
    fields: [
      { f: "address1", label: "Address 1" },
      { f: "address2", label: "Address 2" },
      { f: "address3", label: "Address 3" },
      { f: "town", label: "Town" },
      { f: "state", label: "State / county" },
      { f: "country", label: "Country" },
      { f: "postcode", label: "Postcode" },
    ],
  },
];

// Optional details a customer adds after registering. Nothing here is required; a blank field is simply not stored.
// Two states: SAVED (read-only, with an Edit button) and EDITING (the form, with Save changes and Cancel). A customer with nothing
// saved yet starts in EDITING; one with saved details starts in SAVED. Cancel throws away what was typed and shows what is saved.
// `countries` is built once on the server: the browser's own country-name data can word a few names differently, which would make
// the server-rendered list and the hydrated one disagree.
export function CustomerDetailsClient({ initial, countries }: { initial: ProfileValues; countries: { code: string; name: string }[] }) {
  const [savedValues, setSavedValues] = useState<ProfileValues>(initial); // what is stored in the database right now
  const [editing, setEditing] = useState(() => !PROFILE_FIELDS.some((f) => initial[f]));
  const [values, setValues] = useState<ProfileValues>(initial);
  const editRef = useRef<HTMLButtonElement>(null);
  const [focusTarget, setFocusTarget] = useState<"edit" | "form" | null>(null);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Moves focus after the screen changes state, so keyboard and screen-reader users land somewhere sensible.
  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget === "edit") editRef.current?.focus();
    else document.getElementById("details-title")?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: clears the request once it has been acted on
    setFocusTarget(null);
  }, [focusTarget, editing]);

  function startEditing() {
    setValues(savedValues);
    setErrors({});
    setFormError(null);
    setSaved(null);
    setEditing(true);
    setFocusTarget("form");
  }
  function cancelEditing() {
    if (saving) return;
    setValues(savedValues);
    setErrors({});
    setFormError(null);
    if (PROFILE_FIELDS.some((f) => savedValues[f])) {
      setEditing(false);
      setFocusTarget("edit");
    }
  }

  const set = (f: ProfileField) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [f]: e.target.value }));
    setSaved(null);
    if (errors[f]) setErrors((p) => ({ ...p, [f]: undefined }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/profile/details", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setValues(data.values);
        setSavedValues(data.values);
        setErrors({});
        setSaved(data.smsConsentWithdrawn ? "Your details have been saved. Because the phone number was removed, text-message marketing has been switched off." : "Your details have been saved.");
        setEditing(false);
        setFocusTarget("edit");
        window.dispatchEvent(new CustomEvent("dl-details-saved", { detail: { hasPhone: !!data.values.phone } }));
      } else if (res.status === 400 && data.fieldErrors) {
        setErrors(data.fieldErrors);
        const first = FIELD_ORDER.find((f) => data.fieldErrors[f]);
        if (first) document.getElementById(`details-${first}`)?.focus();
      } else {
        setFormError(data.error ?? "Your details could not be saved. What you typed is still here, so you can try again.");
      }
    } catch {
      setFormError("Could not reach the server, so your details were not saved. What you typed is still here, so you can try again.");
    }
    setSaving(false);
  }

  const common = (f: ProfileField) => ({
    id: `details-${f}`,
    value: values[f],
    onChange: set(f),
    disabled: saving,
    className: controlClass,
    "aria-invalid": errors[f] ? true : undefined,
    "aria-describedby": errors[f] ? `details-${f}-error` : undefined,
  });
  const selectBox = (control: React.ReactNode) => (
    <div className="relative">
      {control}
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
    </div>
  );
  const group = (label: string) => (
    <div className="flex items-center gap-3 pt-1 sm:col-span-2" role="presentation">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{label}</span>
      <span className="h-px flex-1 bg-slate-100" />
    </div>
  );
  const wrap = (f: ProfileField, label: string, control: React.ReactNode, span = false) => (
    <div className={span ? "sm:col-span-2" : undefined}>
      <label htmlFor={`details-${f}`} className={labelClass}>
        {label}
      </label>
      {control}
      {errors[f] && (
        <p id={`details-${f}-error`} className={errorClass}>
          {errors[f]}
        </p>
      )}
    </div>
  );

  if (!editing) {
    const hasAny = PROFILE_FIELDS.some((f) => savedValues[f]);
    const shown = (f: ProfileField) => (f === "country" ? (savedValues.country ? (countries.find((c) => c.code === savedValues.country)?.name ?? savedValues.country) : "") : savedValues[f]);
    return (
      <div className="p-4 sm:px-6 sm:py-5">
        <div className="mx-auto w-full space-y-4" style={{ maxWidth: FIELD_MAX * 2 + 24 }}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className={hasAny ? "flex items-center gap-2 text-sm font-medium text-emerald-700" : "flex items-center gap-2 text-sm font-medium text-slate-500"}>
              {hasAny && <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />}
              {hasAny ? "Saved" : "Nothing saved yet"}
            </p>
            <Button ref={editRef} type="button" variant="outline" onClick={startEditing} className="h-[38px] w-full sm:w-auto" data-testid="details-edit">
              <Pencil className="h-4 w-4" aria-hidden="true" /> {hasAny ? "Edit" : "Add details"}
            </Button>
          </div>
          {saved && (
            <p role="status" className="flex items-start gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {saved}
            </p>
          )}
          {!hasAny && <p className="text-[13px] leading-relaxed text-slate-600">You have not added any details. None is required to use your account.</p>}
          {VIEW_ROWS.map((g) => (
            <section key={g.group} aria-label={g.group} className="space-y-3">
              <div className="flex items-center gap-3 pt-1" role="presentation">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{g.group}</span>
                <span className="h-px flex-1 bg-slate-100" />
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3.5 sm:grid-cols-2">
                {g.fields.map(({ f, label }) => (
                  <div key={f} data-field={f} className="min-w-0">
                    <dt className="text-xs font-semibold text-slate-500">{label}</dt>
                    <dd className={shown(f) ? "mt-0.5 break-words text-sm text-slate-900" : "mt-0.5 text-sm text-slate-400"}>{shown(f) || "Not provided"}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="p-4 sm:px-6 sm:py-5">
      <div className="mx-auto w-full space-y-4" style={{ maxWidth: FIELD_MAX * 2 + 24 }}>
        <p className="text-[13px] leading-relaxed text-slate-600">
          None of these details is required to use your account. Add only what you want us to hold. See the <a href="/privacy-policy" className="font-semibold text-indigo-700 underline underline-offset-2 focus-ring">Privacy policy</a>.
        </p>
        {formError && (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {formError}
          </div>
        )}
        <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          {group("About you")}
          {wrap("title", "Title", selectBox(
            <Select {...common("title")} className={`${controlClass} appearance-none pr-9`}>
              <option value="">Not stated</option>
              {TITLES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          ))}
          {wrap("firstName", "First name", <Input type="text" autoComplete="given-name" maxLength={60} {...common("firstName")} />)}
          {wrap("middleName", "Middle name", <Input type="text" autoComplete="additional-name" maxLength={60} {...common("middleName")} />)}
          {wrap("surname", "Last name", <Input type="text" autoComplete="family-name" maxLength={80} {...common("surname")} />)}
          {wrap("businessName", "Business name", <Input type="text" autoComplete="organization" maxLength={120} {...common("businessName")} />)}
          {wrap("phone", "Phone number", <Input type="tel" autoComplete="tel" inputMode="tel" maxLength={24} placeholder="07700 900123" {...common("phone")} />)}
          {group("Address")}
          {wrap("address1", "Address 1", <Input type="text" autoComplete="address-line1" maxLength={100} {...common("address1")} />)}
          {wrap("address2", "Address 2", <Input type="text" autoComplete="address-line2" maxLength={100} {...common("address2")} />)}
          {wrap("address3", "Address 3", <Input type="text" autoComplete="address-line3" maxLength={100} {...common("address3")} />)}
          {wrap("town", "Town", <Input type="text" autoComplete="address-level2" maxLength={80} {...common("town")} />)}
          {wrap("state", "State / county", <Input type="text" autoComplete="address-level1" maxLength={80} {...common("state")} />)}
          {wrap("country", "Country", selectBox(
            <Select autoComplete="country" {...common("country")} className={`${controlClass} appearance-none pr-9`}>
              <option value="">Not stated</option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </Select>
          ))}
          {wrap("postcode", "Postcode", <Input type="text" autoComplete="postal-code" maxLength={12} {...common("postcode")} />)}
          <div className="flex items-end gap-2">
            <Button type="submit" disabled={saving} className="h-[38px] flex-1">
              {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={cancelEditing} className="h-[38px]">
              Cancel
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs leading-relaxed text-slate-500">
            {values.country === DEFAULT_COUNTRY || !values.country ? "UK postcodes are checked for the correct shape (for example SW1A 1AA). UK phone numbers can start with 0." : "Postcode and phone are checked for a sensible format; start international numbers with + and the country code."}
          </p>
        </div>
      </div>
    </form>
  );
}
