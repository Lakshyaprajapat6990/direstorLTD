"use client";

import { FormatToolbar, type BlockKind } from "./FormatToolbar";
import { RunEditor } from "./RunEditor";
import { BlockLayoutForm } from "./panels";
import { cn } from "@/lib/cn";
import { makeRich, richAlign, richBlock, richPlain, richRuns, runsText, type Align, type BlockProps, type RichValue, type Run } from "@/lib/site-content/rich";

// The editing controls the inspector is made of. Plain fields are inputs, rich fields have the formatting toolbar and the
// text editor, and all of them show their length against the limit and the server's validation message when there is one.

const inputCls = (err?: string | null) => cn("mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 focus-ring", err ? "border-red-400" : "border-slate-300");

function Meta({ id, error, length, max, hint }: { id: string; error?: string | null; length: number; max: number; hint?: string }) {
  return (
    <p id={`${id}-help`} className={cn("mt-1 flex justify-between gap-3 text-xs", error ? "text-red-700" : length > max ? "text-red-700" : "text-slate-400")}>
      <span>{error ?? hint ?? "Plain text"}</span>
      <span className="shrink-0 tabular-nums">
        {length}/{max}
      </span>
    </p>
  );
}

export function PlainField({ id, label, value, max, multiline, error, hint, autoFocus, onChange }: { id: string; label: string; value: string; max: number; multiline?: boolean; error?: string | null; hint?: string; autoFocus?: boolean; onChange: (v: string) => void }) {
  const common = { id, value, autoFocus, "aria-invalid": error ? true : undefined, "aria-describedby": `${id}-help`, onChange: (e: { target: { value: string } }) => onChange(e.target.value.replace(/[\r\n]+/g, " ")) };
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </label>
      {multiline ? <textarea rows={max > 400 ? 6 : 3} className={inputCls(error)} {...common} /> : <input type="text" className={inputCls(error)} {...common} />}
      <Meta id={id} error={error} length={value.length} max={max} hint={hint} />
    </div>
  );
}

export function RichField({ id, label, value, max, error, hint, showAlign = true, autoFocus, onChange }: { id: string; label: string; value: RichValue; max: number; error?: string | null; hint?: string; showAlign?: boolean; autoFocus?: boolean; onChange: (v: RichValue) => void }) {
  const align = richAlign(value);
  const block = richBlock(value);
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </label>
      <div className="mt-1 space-y-2">
        <FormatToolbar align={align} onAlign={showAlign ? (a) => onChange(makeRich(richRuns(value), a, false, block)) : undefined} block={block} onBlock={showAlign ? (patch) => onChange(makeRich(richRuns(value), align, false, { ...block, ...patch })) : undefined} />
        <RunEditor id={id} label={label} runs={richRuns(value)} invalid={!!error} describedBy={`${id}-help`} autoFocus={autoFocus} onChange={(runs) => onChange(makeRich(runs, align, false, block))} />
      </div>
      <Meta id={id} error={error} length={richPlain(value).length} max={max} hint={hint ?? "Select words to format them"} />
      {showAlign && <div className="mt-2"><BlockLayoutForm idPrefix={`${id}-layout`} block={block} onBlock={(patch) => onChange(makeRich(richRuns(value), align, false, { ...block, ...patch }))} /></div>}
    </div>
  );
}

// Block text / list items, which are always stored as a list of runs.
export function RunsField({ id, label, runs, max, align, error, onAlign, block, onBlock, kind, onKind, onImage, onChange, compact }: { id: string; label: string; runs: Run[]; max: number; align?: Align; error?: string | null; onAlign?: (a: Align | undefined) => void; block?: BlockProps; onBlock?: (patch: BlockProps) => void; kind?: BlockKind; onKind?: (k: BlockKind) => void; onImage?: () => void; onChange: (runs: Run[]) => void; compact?: boolean }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </label>
      <div className="mt-1 space-y-2">
        {!compact && <FormatToolbar align={align} onAlign={onAlign} block={block} onBlock={onBlock} kind={kind} onKind={onKind} onImage={onImage} />}
        <RunEditor id={id} label={label} runs={runs} invalid={!!error} describedBy={`${id}-help`} onChange={onChange} />
      </div>
      <Meta id={id} error={error} length={runsText(runs).length} max={max} hint="Select words to format them" />
      {onBlock && !compact && <div className="mt-2"><BlockLayoutForm idPrefix={`${id}-layout`} block={block ?? {}} onBlock={onBlock} /></div>}
    </div>
  );
}
