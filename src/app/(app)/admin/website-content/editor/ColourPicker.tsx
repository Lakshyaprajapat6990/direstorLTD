"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { BRAND_SWATCHES, contrastLevel, contrastRatio, hexToHsv, hsvToHex, isHex, parseHex, type Hsv } from "@/lib/site-content/colour";

// A custom colour picker: a saturation/brightness area, a hue slider, a hex box, the site's own colours, recently used colours and
// saved text/background combinations. Everything it produces is a lower-case "#rrggbb" string: the same thing the server accepts
// and the only thing the page ever turns into a colour (see lib/site-content/colour.ts). Nothing typed here can become CSS.

// ---- recently used colours and saved combinations (this browser only) ------------------------------------------------------------

export interface Combo {
  text: string;
  bg: string;
}
interface Memory {
  recent: string[];
  combos: Combo[];
  remember(hex: string): void;
  saveCombo(c: Combo): void;
  removeCombo(c: Combo): void;
}
const KEY = "cms-colour-memory-v1";
const noMemory: Memory = { recent: [], combos: [], remember: () => {}, saveCombo: () => {}, removeCombo: () => {} };
const MemoryCtx = createContext<Memory>(noMemory);
export const useColourMemory = () => useContext(MemoryCtx);

function load(): { recent: string[]; combos: Combo[] } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as { recent?: unknown; combos?: unknown };
    const recent = Array.isArray(raw.recent) ? raw.recent.filter(isHex).slice(0, 12) : [];
    const combos = Array.isArray(raw.combos) ? (raw.combos as Combo[]).filter((c) => c && isHex(c.text) && isHex(c.bg)).slice(0, 8) : [];
    return { recent, combos };
  } catch {
    return { recent: [], combos: [] };
  }
}

export function ColourMemoryProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ recent: string[]; combos: Combo[] }>({ recent: [], combos: [] });
  // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage can only be read after hydration; reading it during render would not match the server HTML
  useEffect(() => setState(load()), []);
  const persist = (next: { recent: string[]; combos: Combo[] }) => {
    setState(next);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* private mode or storage blocked: the colours just are not remembered */
    }
  };
  const value = useMemo<Memory>(
    () => ({
      ...state,
      remember: (hex) => isHex(hex) && persist({ ...state, recent: [hex, ...state.recent.filter((x) => x !== hex)].slice(0, 12) }),
      saveCombo: (c) => persist({ ...state, combos: [c, ...state.combos.filter((x) => x.text !== c.text || x.bg !== c.bg)].slice(0, 8) }),
      removeCombo: (c) => persist({ ...state, combos: state.combos.filter((x) => x.text !== c.text || x.bg !== c.bg) }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persist only closes over setState
    [state]
  );
  return <MemoryCtx.Provider value={value}>{children}</MemoryCtx.Provider>;
}

// ---- contrast ------------------------------------------------------------------------------------------------------------------

export function ContrastNote({ fg, bg, what = "text" }: { fg: string | undefined; bg: string | undefined; what?: string }) {
  if (!fg || !bg || !isHex(fg) || !isHex(bg)) return null;
  const ratio = contrastRatio(fg, bg);
  const level = contrastLevel(ratio);
  const r = `${ratio.toFixed(1)}:1`;
  return (
    <p role="status" data-testid="contrast-note" data-level={level} className={cn("rounded-md px-2 py-1 text-xs", level === "ok" ? "bg-green-50 text-green-800" : level === "large" ? "bg-amber-50 text-amber-900" : "bg-red-50 text-red-800")}>
      {level === "ok" ? `Contrast ${r}: easy to read.` : level === "large" ? `Contrast ${r}: fine for large ${what} only. Small ${what} may be hard to read.` : `Low contrast ${r}: this ${what} will be hard to read. Choose colours that are further apart.`}
    </p>
  );
}

// ---- the picker panel -------------------------------------------------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function ColourPanel({ value, fallback, onChange, onCommit, onReset, idPrefix, against, againstWhat, comboWith }: { value: string | undefined; fallback: string; onChange: (hex: string) => void; onCommit?: (hex: string) => void; onReset?: () => void; idPrefix: string; against?: string; againstWhat?: string; comboWith?: { role: "text" | "bg"; other: string | undefined } }) {
  const memory = useColourMemory();
  const current = value ?? fallback;
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(isHex(current) ? current : "#000000"));
  const [draft, setDraft] = useState(current);
  const area = useRef<HTMLDivElement>(null);

  // Follow outside changes (undo, another control, picking a swatch) without disturbing the hue while dragging.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate prop-to-state sync: the hue must not jump while the user drags, so this cannot be derived during render
    if (isHex(current) && hsvToHex(hsv) !== current) setHsv(hexToHsv(current));
    setDraft(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the value changes from outside
  }, [current]);

  const emit = useCallback(
    (next: Hsv, commit = false) => {
      setHsv(next);
      const hex = hsvToHex(next);
      onChange(hex);
      if (commit) onCommit?.(hex);
    },
    [onChange, onCommit]
  );

  const fromPointer = (e: React.PointerEvent, commit: boolean) => {
    const r = area.current?.getBoundingClientRect();
    if (!r) return;
    emit({ h: hsv.h, s: clamp((e.clientX - r.left) / r.width, 0, 1), v: clamp(1 - (e.clientY - r.top) / r.height, 0, 1) }, commit);
  };

  // Shown as soon as what is typed cannot become a colour; nothing is applied until it can.
  const error = parseHex(draft) ? null : "Use a six-digit colour such as #2457E8.";

  const applyDraft = () => {
    const hex = parseHex(draft);
    if (!hex) return;
    setHsv(hexToHsv(hex));
    onChange(hex);
    onCommit?.(hex);
  };

  const pick = (hex: string) => {
    setHsv(hexToHsv(hex));
    onChange(hex);
    onCommit?.(hex);
  };

  const hueHex = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm" role="group" aria-label="Colour picker" data-testid="colour-panel" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault(); }}>
      <div
        ref={area}
        role="slider"
        tabIndex={0}
        aria-label="Colour: saturation and brightness"
        aria-valuetext={`${current}`}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        data-testid="colour-area"
        className="relative h-32 w-full cursor-crosshair touch-none rounded-md focus-ring"
        style={{ backgroundColor: hueHex, backgroundImage: "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)" }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          fromPointer(e, false);
        }}
        onPointerMove={(e) => e.buttons === 1 && fromPointer(e, false)}
        onPointerUp={(e) => fromPointer(e, true)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
          if (!d) return;
          e.preventDefault();
          emit({ h: hsv.h, s: clamp(hsv.s + d[0], 0, 1), v: clamp(hsv.v + d[1], 0, 1) }, true);
        }}
      >
        <span className="pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-1 ring-black/30" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: current }} />
      </div>

      <div>
        <label htmlFor={`${idPrefix}-hue`} className="sr-only">
          Hue
        </label>
        <input
          id={`${idPrefix}-hue`}
          type="range"
          min={0}
          max={360}
          value={Math.round(hsv.h)}
          onChange={(e) => emit({ ...hsv, h: Number(e.target.value) })}
          onPointerUp={() => onCommit?.(hsvToHex(hsv))}
          className="h-3 w-full cursor-pointer appearance-none rounded-full"
          style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
        />
      </div>

      <div>
        <label htmlFor={`${idPrefix}-hex`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Hex colour
        </label>
        <div className="mt-1 flex items-center gap-2">
          <span className="h-8 w-8 shrink-0 rounded-md border border-slate-300" style={{ backgroundColor: current }} aria-hidden />
          <input
            id={`${idPrefix}-hex`}
            value={draft}
            maxLength={9}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${idPrefix}-hex-err` : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              const hex = parseHex(e.target.value);
              if (hex) {
                setHsv(hexToHsv(hex));
                onChange(hex);
              }
            }}
            onBlur={() => parseHex(draft) && applyDraft()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyDraft();
              }
            }}
            placeholder="#2457E8"
            className={cn("min-w-0 flex-1 rounded-md border px-2 py-1.5 font-mono text-sm uppercase focus-ring", error ? "border-red-400" : "border-slate-300")}
          />
        </div>
        {error && (
          <p id={`${idPrefix}-hex-err`} role="status" className="mt-1 text-xs text-red-700">
            {error}
          </p>
        )}
      </div>

      <Swatches label="Site colours" colours={BRAND_SWATCHES} current={current} onPick={pick} />
      {memory.recent.length > 0 && <Swatches label="Recently used" colours={memory.recent.map((hex) => ({ hex, label: hex }))} current={current} onPick={pick} />}

      {comboWith && (
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Saved combinations</p>
            {comboWith.other && (
              <button type="button" data-testid="save-combo" onClick={() => memory.saveCombo(comboWith.role === "text" ? { text: current, bg: comboWith.other! } : { text: comboWith.other!, bg: current })} className="text-xs font-semibold text-indigo-700 hover:underline focus-ring">
                Save this pair
              </button>
            )}
          </div>
          {memory.combos.length === 0 ? (
            <p className="mt-1 text-xs text-slate-400">None yet. A pair is a text colour with its background.</p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {memory.combos.map((c) => (
                <li key={`${c.text}${c.bg}`} className="flex items-center">
                  <button type="button" title={`Use text ${c.text} on ${c.bg}`} aria-label={`Use saved pair: text ${c.text} on ${c.bg}`} onClick={() => pick(comboWith.role === "text" ? c.text : c.bg)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-bold focus-ring" style={{ color: c.text, backgroundColor: c.bg }}>
                    Aa
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {against && <ContrastNote fg={comboWith?.role === "bg" ? against : current} bg={comboWith?.role === "bg" ? current : against} what={againstWhat} />}

      {onReset && (
        <button type="button" onClick={onReset} data-testid="colour-reset" className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 hover:underline focus-ring">
          <RotateCcw className="h-3 w-3" aria-hidden /> Reset to default
        </button>
      )}
    </div>
  );
}

function Swatches({ label, colours, current, onPick }: { label: string; colours: { hex: string; label: string }[]; current: string; onPick: (hex: string) => void }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {colours.map((c) => (
          <li key={c.hex}>
            <button type="button" title={`${c.label} ${c.hex}`} aria-label={`${c.label} ${c.hex}`} aria-pressed={current === c.hex} onClick={() => onPick(c.hex)} className={cn("flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 focus-ring", current === c.hex && "ring-2 ring-indigo-500 ring-offset-1")} style={{ backgroundColor: c.hex }}>
              {current === c.hex && <Check className="h-3 w-3" style={{ color: contrastRatio(c.hex, "#ffffff") > 3 ? "#fff" : "#000" }} aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- a labelled colour control for forms -------------------------------------------------------------------------------------------

export function ColourField({ id, label, value, fallback, fallbackLabel = "Default", onChange, against, againstWhat, comboWith, hint }: { id: string; label: string; value: string | undefined; fallback: string; fallbackLabel?: string; onChange: (hex: string | undefined) => void; against?: string; againstWhat?: string; comboWith?: { role: "text" | "bg"; other: string | undefined }; hint?: string }) {
  const [open, setOpen] = useState(false);
  const memory = useColourMemory();
  return (
    <div data-colour-field={id}>
      <span id={`${id}-label`} className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <button type="button" id={id} aria-expanded={open} aria-labelledby={`${id}-label ${id}`} onClick={() => setOpen((o) => !o)} className="mt-1 flex w-full items-center gap-2 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-left text-sm focus-ring">
        <span className="h-5 w-5 shrink-0 rounded border border-slate-300" style={{ backgroundColor: value ?? fallback }} aria-hidden />
        <span className="font-mono text-xs uppercase text-slate-700" data-testid={`${id}-value`}>
          {value ?? fallbackLabel}
        </span>
        <span className="ml-auto text-xs text-slate-400">{open ? "Close" : "Change"}</span>
      </button>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
      {open && (
        <div className="mt-2">
          <ColourPanel value={value} fallback={fallback} idPrefix={`${id}-p`} onChange={(hex) => onChange(hex)} onCommit={(hex) => memory.remember(hex)} onReset={() => onChange(undefined)} against={against} againstWhat={againstWhat} comboWith={comboWith} />
        </div>
      )}
      {!open && against && value && <div className="mt-1"><ContrastNote fg={comboWith?.role === "bg" ? against : value} bg={comboWith?.role === "bg" ? value : against} what={againstWhat} /></div>}
    </div>
  );
}
