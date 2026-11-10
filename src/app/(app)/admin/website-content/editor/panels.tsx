"use client";

import { useState, type ReactNode } from "react";
import { ExternalLink, ImagePlus, Link2, Lock, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { BOX_WIDTH_RANGE, INTERNAL_LINKS, PAD_X_RANGE, SPACE_AFTER_RANGE, SPACE_BEFORE_RANGE, validateHref, type BlockProps } from "@/lib/site-content/rich";
import { mediaSrc } from "@/lib/site-content/sections";
import { FONT_LABEL, FONTS, LIMITS, WEIGHTS, WEIGHT_LABEL, buttonCss, headingCss, partCss, type ButtonSettings, type HeadingStyle, type ImageDisplay, type SectionStyle, type StatCardStyle } from "@/lib/site-content/styles";
import { ColourField } from "./ColourPicker";
import { AlignButtons, Check, Group, NumberField, SelectField, labelCls, selectCls } from "./controls";

// The appearance panels: button settings, heading look, section background and spacing, and image display. Each takes the current
// settings object and a `patch` callback (undefined clears one setting), and knows nothing about where the settings are stored.

const FONT_OPTIONS = FONTS.map((f) => ({ value: f, label: FONT_LABEL[f] }));
const WEIGHT_OPTIONS = WEIGHTS.map((w) => ({ value: w, label: WEIGHT_LABEL[w] }));

// ---- buttons ----------------------------------------------------------------------------------------------------------------------

export interface ButtonFormProps {
  idPrefix: string;
  settings: ButtonSettings;
  patch: (p: Partial<Record<keyof ButtonSettings, unknown>>) => void;
  onReset: () => void;
  // The destination the button has in code, and, when the code controls it, why the editor cannot change it.
  defaultHref: string;
  locked: string | null;
  // The colours of the button as designed (shown until the editor chooses others, and used to check contrast).
  look: { bg: string; color: string; border?: string };
  // Buttons side by side share a row; alignment then moves the row instead of one button.
  rowLabel?: string;
  rowAlign?: ButtonSettings["align"];
  onRowAlign?: (a: ButtonSettings["align"]) => void;
  label: string;
  labelField: ReactNode;
}

const CUSTOM = "__custom";

export function ButtonForm(p: ButtonFormProps) {
  const s = p.settings;
  const href = s.href ?? p.defaultHref;
  const internal = INTERNAL_LINKS.some((l) => l.href === href);
  const [mode, setMode] = useState<"internal" | "custom">(internal ? "internal" : "custom");
  const [draft, setDraft] = useState(internal ? "" : href);
  const draftError = mode === "custom" && draft.trim() !== "" ? validateHref(draft.trim()) : null;
  const effBg = s.bg ?? p.look.bg;
  const effText = s.color ?? p.look.color;
  const preview = buttonCss(s);
  const opensNewTab = !p.locked && (!!s.newTab || false);

  return (
    <div className="space-y-4" data-testid="button-form">
      {p.labelField}

      <div data-testid="button-destination" className="space-y-2">
        <span className={labelCls}>Where it goes</span>
        {p.locked ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="destination-locked">
            <p className="flex items-center gap-2 font-semibold text-slate-800">
              <Lock className="h-4 w-4 text-slate-500" aria-hidden /> Destination is controlled in code
            </p>
            <p className="mt-1 text-slate-600">{p.locked}</p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
              <Link2 className="h-3 w-3" aria-hidden /> Opens: <code className="rounded bg-white px-1">{p.defaultHref}</code>
            </p>
            <p className="mt-1 text-xs text-slate-500">You can still change the label and how the button looks.</p>
          </div>
        ) : (
          <>
            <label htmlFor={`${p.idPrefix}-dest`} className="sr-only">
              Destination
            </label>
            <select
              id={`${p.idPrefix}-dest`}
              data-testid="dest-select"
              className={selectCls}
              value={mode === "internal" && internal ? href : CUSTOM}
              onChange={(e) => {
                if (e.target.value === CUSTOM) {
                  setMode("custom");
                  return;
                }
                setMode("internal");
                setDraft("");
                p.patch({ href: e.target.value === p.defaultHref ? undefined : e.target.value });
              }}
            >
              {INTERNAL_LINKS.map((l) => (
                <option key={l.href} value={l.href}>
                  {l.label}
                </option>
              ))}
              <option value={CUSTOM}>Another web address or email…</option>
            </select>
            {mode === "custom" && (
              <div>
                <label htmlFor={`${p.idPrefix}-url`} className="block text-xs font-medium text-slate-600">
                  Web address (https://) or email (mailto:)
                </label>
                <input
                  id={`${p.idPrefix}-url`}
                  data-testid="dest-url"
                  value={draft}
                  placeholder="https://example.com/page"
                  spellCheck={false}
                  aria-invalid={draftError ? true : undefined}
                  aria-describedby={`${p.idPrefix}-url-help`}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    const v = e.target.value.trim();
                    if (v !== "" && validateHref(v) === null) p.patch({ href: v });
                  }}
                  className={cn("mt-1 w-full rounded-lg border px-3 py-2 text-sm focus-ring", draftError ? "border-red-400" : "border-slate-300")}
                />
                <p id={`${p.idPrefix}-url-help`} role={draftError ? "alert" : undefined} className={cn("mt-1 text-xs", draftError ? "text-red-700" : "text-slate-400")}>
                  {draftError ?? "Only https:// addresses, mailto: addresses and this site's own pages are accepted. Nothing is saved until the address is valid."}
                </p>
              </div>
            )}
            <Check id={`${p.idPrefix}-tab`} label="Open in a new tab" checked={!!s.newTab} onChange={(v) => p.patch({ newTab: v ? true : undefined })} hint="New tabs are opened with noopener and noreferrer, so the other site cannot reach this page." />
            <p className="flex items-start gap-1.5 rounded-lg bg-slate-50 px-2.5 py-2 text-xs text-slate-600" data-testid="dest-preview">
              <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>
                Visitors go to <code className="break-all rounded bg-white px-1">{href}</code>
                {opensNewTab ? " in a new tab" : " in the same tab"}.
              </span>
            </p>
          </>
        )}
      </div>

      <div data-testid="button-preview-wrap">
        <span className={labelCls}>Preview</span>
        <div className="mt-1 flex min-h-[4rem] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-100 p-3">
          <span
            data-testid="button-preview"
            className="inline-flex items-center justify-center rounded-md px-8 py-4 text-base font-medium"
            style={{ backgroundColor: p.look.bg, color: p.look.color, ...(p.look.border ? { border: `2px solid ${p.look.border}` } : {}), ...preview }}
          >
            {p.label}
          </span>
        </div>
      </div>

      <Group title="Text">
        <SelectField id={`${p.idPrefix}-font`} label="Font" value={s.font} options={FONT_OPTIONS} onChange={(v) => p.patch({ font: v })} defaultLabel="Site font" />
        <div className="grid grid-cols-2 gap-3">
          <NumberField id={`${p.idPrefix}-size`} label="Size" value={s.size} min={LIMITS.buttonSize[0]} max={LIMITS.buttonSize[1]} placeholder="Default" onChange={(v) => p.patch({ size: v })} />
          <SelectField id={`${p.idPrefix}-weight`} label="Weight" value={s.weight} options={WEIGHT_OPTIONS} onChange={(v) => p.patch({ weight: v })} defaultLabel="Medium" />
        </div>
      </Group>

      <Group title="Colours">
        <ColourField id={`${p.idPrefix}-text`} label="Text colour" value={s.color} fallback={p.look.color} onChange={(v) => p.patch({ color: v })} against={effBg} againstWhat="button text" comboWith={{ role: "text", other: effBg }} />
        <ColourField id={`${p.idPrefix}-bg`} label="Background colour" value={s.bg} fallback={p.look.bg} onChange={(v) => p.patch({ bg: v })} against={effText} againstWhat="button text" comboWith={{ role: "bg", other: effText }} />
        <ColourField id={`${p.idPrefix}-border`} label="Border colour" value={s.borderColor} fallback={p.look.border ?? p.look.bg} fallbackLabel={p.look.border ? "Default" : "None"} onChange={(v) => p.patch({ borderColor: v })} />
      </Group>

      <Group title="Shape and size">
        <div className="grid grid-cols-2 gap-3">
          <NumberField id={`${p.idPrefix}-bw`} label="Border width" value={s.borderWidth} min={LIMITS.borderWidth[0]} max={LIMITS.borderWidth[1]} placeholder="Default" onChange={(v) => p.patch({ borderWidth: v })} />
          <NumberField id={`${p.idPrefix}-radius`} label="Corner radius" value={s.radius} min={LIMITS.radius[0]} max={LIMITS.radius[1]} placeholder="Default" onChange={(v) => p.patch({ radius: v })} />
          <NumberField id={`${p.idPrefix}-px`} label="Padding, sides" value={s.padX} min={LIMITS.padX[0]} max={LIMITS.padX[1]} placeholder="Default" onChange={(v) => p.patch({ padX: v })} />
          <NumberField id={`${p.idPrefix}-py`} label="Padding, top and bottom" value={s.padY} min={LIMITS.padY[0]} max={LIMITS.padY[1]} placeholder="Default" onChange={(v) => p.patch({ padY: v })} />
        </div>
      </Group>

      <Group title="Position">
        {p.rowLabel ? (
          <AlignButtons testId="button-align" label={`Alignment of the ${p.rowLabel}`} value={p.rowAlign} onChange={(a) => p.onRowAlign?.(a)} />
        ) : (
          <AlignButtons testId="button-align" label="Alignment" value={s.align} onChange={(a) => p.patch({ align: a })} />
        )}
      </Group>

      <Button size="sm" variant="outline" onClick={p.onReset} data-testid="button-reset">
        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset button look
      </Button>
    </div>
  );
}

// ---- headings ---------------------------------------------------------------------------------------------------------------------

type Scope = "whole" | "lead" | "accent";
const SCOPE_KEYS = {
  whole: { font: "font", weight: "weight", italic: "italic" },
  lead: { font: "leadFont", weight: "leadWeight", italic: "leadItalic" },
  accent: { font: "accentFont", weight: "accentWeight", italic: "accentItalic" },
} as const;

// Look of a heading or of any other plain-text element. A two-part heading (plain text in two pieces) can take font, weight and italic
// for the whole heading, for its first part, or for its highlighted part only: the choice below says which one is being changed.
export function HeadingStyleForm({ idPrefix, style, patch, onReset, defaults, parts, title = "Heading look", noun = "heading" }: { idPrefix: string; style: HeadingStyle; patch: (p: Partial<Record<keyof HeadingStyle, unknown>>) => void; onReset: () => void; defaults: { color: string; on: string; size?: number }; parts: boolean; title?: string; noun?: string }) {
  const [scope, setScope] = useState<Scope>("whole");
  const preview = headingCss(style);
  const k = SCOPE_KEYS[scope];
  const st = style as Record<string, unknown>;
  return (
    <Group title={title} open={false}>
      <div className="rounded-lg border border-dashed border-slate-300 bg-white p-3" style={{ backgroundColor: defaults.on }} data-testid="heading-preview-wrap">
        <p className="font-extrabold leading-tight" data-testid="heading-preview" style={{ color: defaults.color, fontSize: "1.5rem", ...preview, ...(style.size !== undefined ? { fontSize: `${Math.min(style.size, 48)}px` } : {}) }}>
          {parts ? (
            <>
              <span style={partCss(style, "lead")}>First part </span>
              <span style={{ color: "#1a56e8", ...partCss(style, "accent") }}>highlighted part</span>
            </>
          ) : (
            "Text preview"
          )}
        </p>
      </div>
      {parts && (
        <div>
          <label htmlFor={`${idPrefix}-scope`} className={labelCls}>
            Font, weight and italic apply to
          </label>
          <select id={`${idPrefix}-scope`} data-testid="heading-scope" value={scope} onChange={(e) => setScope(e.target.value as Scope)} className={selectCls}>
            <option value="whole">The whole {noun}</option>
            <option value="lead">The first part only</option>
            <option value="accent">The highlighted part only</option>
          </select>
        </div>
      )}
      <SelectField id={`${idPrefix}-font`} label="Font" value={st[k.font] as HeadingStyle["font"]} options={FONT_OPTIONS} onChange={(v) => patch({ [k.font]: v })} defaultLabel="Site font" />
      <div className="grid grid-cols-2 gap-3">
        <NumberField id={`${idPrefix}-size`} label="Size" value={style.size} min={LIMITS.headingSize[0]} max={LIMITS.headingSize[1]} placeholder="Default" onChange={(v) => patch({ size: v })} hint="Large sizes shrink on small screens" />
        <SelectField id={`${idPrefix}-weight`} label="Weight" value={st[k.weight] as HeadingStyle["weight"]} options={WEIGHT_OPTIONS} onChange={(v) => patch({ [k.weight]: v })} defaultLabel="Default" />
      </div>
      <Check id={`${idPrefix}-italic`} label="Italic" checked={!!st[k.italic]} onChange={(v) => patch({ [k.italic]: v ? true : undefined })} />
      <ColourField id={`${idPrefix}-colour`} label={`${parts ? "Whole heading" : "Text"} colour`} value={style.color} fallback={defaults.color} onChange={(v) => patch({ color: v })} against={defaults.on} againstWhat={noun} comboWith={{ role: "text", other: defaults.on }} />
      {parts && <ColourField id={`${idPrefix}-accent`} label="Highlighted part colour" value={style.accentColor} fallback="#1a56e8" onChange={(v) => patch({ accentColor: v })} against={defaults.on} againstWhat={noun} />}
      <AlignButtons testId="heading-align" label="Alignment" value={style.align} onChange={(a) => patch({ align: a })} />
      <Button size="sm" variant="outline" onClick={onReset}>
        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset look
      </Button>
    </Group>
  );
}

// ---- paragraph layout (position of the whole block, as opposed to alignment of its text) ----------------------------------------------------

export function BlockLayoutForm({ idPrefix, block, onBlock }: { idPrefix: string; block: BlockProps; onBlock: (p: BlockProps) => void }) {
  const any = Object.keys(block).some((k) => ["spaceBefore", "spaceAfter", "padX", "boxWidth", "boxAlign"].includes(k));
  return (
    <Group title="Block position and spacing" open={false}>
      <p className="text-xs text-slate-500">Moves or spaces the whole block. (Left, centre, right and justify above change the text inside it.)</p>
      <div className="grid grid-cols-2 gap-3">
        <NumberField id={`${idPrefix}-width`} label="Block width" unit="%" value={block.boxWidth} min={BOX_WIDTH_RANGE[0]} max={BOX_WIDTH_RANGE[1]} placeholder="Default" onChange={(v) => onBlock({ boxWidth: v })} hint="Never wider than the page" />
        <NumberField id={`${idPrefix}-padx`} label="Side padding" value={block.padX} min={PAD_X_RANGE[0]} max={PAD_X_RANGE[1]} placeholder="Default" onChange={(v) => onBlock({ padX: v })} />
        <NumberField id={`${idPrefix}-before`} label="Space above" value={block.spaceBefore} min={SPACE_BEFORE_RANGE[0]} max={SPACE_BEFORE_RANGE[1]} placeholder="Default" onChange={(v) => onBlock({ spaceBefore: v })} />
        <NumberField id={`${idPrefix}-after`} label="Space below" value={block.spaceAfter} min={SPACE_AFTER_RANGE[0]} max={SPACE_AFTER_RANGE[1]} placeholder="Default" onChange={(v) => onBlock({ spaceAfter: v })} />
      </div>
      <AlignButtons testId="block-position" label="Block position (when narrower than the page)" value={block.boxAlign} onChange={(a) => onBlock({ boxAlign: a })} />
      <Button size="sm" variant="outline" disabled={!any} onClick={() => onBlock({ spaceBefore: undefined, spaceAfter: undefined, padX: undefined, boxWidth: undefined, boxAlign: undefined })} data-testid="block-reset">
        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset position and spacing
      </Button>
    </Group>
  );
}

// ---- figure cards ------------------------------------------------------------------------------------------------------------------------

export function StatCardsForm({ idPrefix, style, patch, onReset, onApplyAll }: { idPrefix: string; style: StatCardStyle; patch: (p: Partial<Record<keyof StatCardStyle, unknown>>) => void; onReset: () => void; onApplyAll?: () => void }) {
  return (
    <div className="space-y-4" data-testid="stat-cards-form">
      <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="stat-live-note">
        <Lock className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden /> The figures are counted live from the database and cannot be typed over. You can change how the cards look and edit the captions under the figures (click a caption).
      </p>
      <Group title="Card">
        <ColourField id={`${idPrefix}-bg`} label="Background colour" value={style.bg} fallback="#ffffff" onChange={(v) => patch({ bg: v })} />
        <ColourField id={`${idPrefix}-border`} label="Border colour" value={style.borderColor} fallback="#e2e8f0" onChange={(v) => patch({ borderColor: v })} />
        <div className="grid grid-cols-2 gap-3">
          <NumberField id={`${idPrefix}-bw`} label="Border width" value={style.borderWidth} min={LIMITS.borderWidth[0]} max={LIMITS.borderWidth[1]} placeholder="Default" onChange={(v) => patch({ borderWidth: v })} />
          <NumberField id={`${idPrefix}-radius`} label="Corner radius" value={style.radius} min={LIMITS.radius[0]} max={LIMITS.radius[1]} placeholder="Default" onChange={(v) => patch({ radius: v })} />
          <NumberField id={`${idPrefix}-px`} label="Padding, sides" value={style.padX} min={LIMITS.padX[0]} max={LIMITS.padX[1]} placeholder="Default" onChange={(v) => patch({ padX: v })} />
          <NumberField id={`${idPrefix}-py`} label="Padding, top and bottom" value={style.padY} min={LIMITS.padY[0]} max={LIMITS.padY[1]} placeholder="Default" onChange={(v) => patch({ padY: v })} />
        </div>
        <AlignButtons testId="stat-align" label="Alignment of the text in the card" value={style.align} onChange={(a) => patch({ align: a })} />
      </Group>
      <Group title="The figure (appearance only)">
        <SelectField id={`${idPrefix}-vfont`} label="Font" value={style.valueFont} options={FONT_OPTIONS} onChange={(v) => patch({ valueFont: v })} defaultLabel="Site font" />
        <div className="grid grid-cols-2 gap-3">
          <NumberField id={`${idPrefix}-vsize`} label="Size" value={style.valueSize} min={LIMITS.headingSize[0]} max={LIMITS.headingSize[1]} placeholder="Default" onChange={(v) => patch({ valueSize: v })} />
          <SelectField id={`${idPrefix}-vweight`} label="Weight" value={style.valueWeight} options={WEIGHT_OPTIONS} onChange={(v) => patch({ valueWeight: v })} defaultLabel="Bold" />
        </div>
        <Check id={`${idPrefix}-vitalic`} label="Italic" checked={!!style.valueItalic} onChange={(v) => patch({ valueItalic: v ? true : undefined })} />
        <ColourField id={`${idPrefix}-vcolour`} label="Figure colour" value={style.valueColor} fallback="#0b2a6f" onChange={(v) => patch({ valueColor: v })} against={style.bg ?? "#ffffff"} againstWhat="figure" comboWith={{ role: "text", other: style.bg }} />
        <div className="grid grid-cols-2 gap-3">
          <NumberField id={`${idPrefix}-lsize`} label="Caption size" value={style.labelSize} min={LIMITS.buttonSize[0]} max={LIMITS.buttonSize[1]} placeholder="Default" onChange={(v) => patch({ labelSize: v })} />
          <SelectField id={`${idPrefix}-lweight`} label="Caption weight" value={style.labelWeight} options={WEIGHT_OPTIONS} onChange={(v) => patch({ labelWeight: v })} defaultLabel="Default" />
        </div>
        <Check id={`${idPrefix}-litalic`} label="Caption italic" checked={!!style.labelItalic} onChange={(v) => patch({ labelItalic: v ? true : undefined })} />
        <ColourField id={`${idPrefix}-lcolour`} label="Caption colour" value={style.labelColor} fallback="#64748b" onChange={(v) => patch({ labelColor: v })} against={style.bg ?? "#ffffff"} againstWhat="caption" />
      </Group>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onReset} data-testid="stat-reset">
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset appearance
        </Button>
        {onApplyAll && (
          <Button size="sm" variant="outline" onClick={onApplyAll} data-testid="stat-apply-all">
            Use this look for all six cards
          </Button>
        )}
      </div>
    </div>
  );
}

// ---- sections ---------------------------------------------------------------------------------------------------------------------

export function SectionStyleForm({ idPrefix, style, patch, onReset, textColour, defaultBg }: { idPrefix: string; style: SectionStyle; patch: (p: Partial<Record<keyof SectionStyle, unknown>>) => void; onReset: () => void; textColour: string; defaultBg: string }) {
  return (
    <Group title="Background and spacing" open={false}>
      <ColourField id={`${idPrefix}-bg`} label="Background colour" value={style.bg} fallback={defaultBg} fallbackLabel="Section default" onChange={(v) => patch({ bg: v })} against={textColour} againstWhat="section text" comboWith={{ role: "bg", other: textColour }} hint="Replaces the section's own background, including gradients." />
      <div className="grid grid-cols-2 gap-3">
        <NumberField id={`${idPrefix}-pt`} label="Space above" value={style.padTop} min={LIMITS.sectionPad[0]} max={LIMITS.sectionPad[1]} placeholder="Default" onChange={(v) => patch({ padTop: v })} />
        <NumberField id={`${idPrefix}-pb`} label="Space below" value={style.padBottom} min={LIMITS.sectionPad[0]} max={LIMITS.sectionPad[1]} placeholder="Default" onChange={(v) => patch({ padBottom: v })} />
      </div>
      <Button size="sm" variant="outline" onClick={onReset}>
        <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reset section look
      </Button>
    </Group>
  );
}

// ---- images -----------------------------------------------------------------------------------------------------------------------

export interface ImageFormProps {
  idPrefix: string;
  mediaId: string;
  alt: string;
  caption: string | undefined;
  natural: { width?: number; height?: number };
  display: ImageDisplay;
  // Floating beside text only makes sense for an image between paragraphs.
  allowWrap: boolean;
  errors: { alt?: string | null; caption?: string | null };
  onField: (field: "alt" | "caption", value: string) => void;
  patch: (p: Partial<Record<keyof ImageDisplay, unknown>>) => void;
  onReplace: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  // The "width" choice of an image section (text width or wide); shown only for sections.
  sizeChoice?: ReactNode;
}

export function ImageForm(p: ImageFormProps) {
  const d = p.display;
  const iw = p.natural.width;
  const ih = p.natural.height;
  const [lock, setLock] = useState(d.displayWidth === undefined || d.displayHeight === undefined);
  const ratio = iw && ih ? ih / iw : undefined;

  const setWidth = (w: number | undefined) => {
    if (w === undefined) return p.patch({ displayWidth: undefined, displayHeight: lock ? undefined : d.displayHeight });
    p.patch({ displayWidth: w, ...(lock ? { displayHeight: undefined } : {}) });
  };
  const setHeight = (h: number | undefined) => {
    if (h === undefined) return p.patch({ displayHeight: undefined });
    if (lock && ratio) return p.patch({ displayWidth: Math.max(LIMITS.imageSide[0], Math.min(LIMITS.imageSide[1], Math.round(h / ratio))), displayHeight: undefined });
    p.patch({ displayHeight: h });
  };
  const shownHeight = d.displayHeight ?? (lock && d.displayWidth && ratio ? Math.round(d.displayWidth * ratio) : undefined);

  return (
    <div className="space-y-4" data-testid="image-form">
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        {/* eslint-disable-next-line @next/next/no-img-element -- our own /media route */}
        <img src={mediaSrc(p.mediaId)} alt={p.alt} className="max-h-48 w-full object-contain" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={p.onReplace} data-testid="image-replace">
          <ImagePlus className="h-3.5 w-3.5" aria-hidden /> Replace image
        </Button>
        {p.onRemove && (
          <Button size="sm" variant="danger" onClick={p.onRemove} data-testid="image-remove">
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> {p.removeLabel ?? "Remove image"}
          </Button>
        )}
      </div>

      <div>
        <label htmlFor={`${p.idPrefix}-alt`} className={labelCls}>
          Image description (alt text)
        </label>
        <input id={`${p.idPrefix}-alt`} value={p.alt} maxLength={160} onChange={(e) => p.onField("alt", e.target.value)} className={cn(selectCls, p.errors.alt && "border-red-400")} aria-invalid={p.errors.alt ? true : undefined} />
        <p className={cn("mt-1 text-xs", p.errors.alt ? "text-red-700" : "text-slate-400")}>{p.errors.alt ?? "Describe the image for people who cannot see it"}</p>
      </div>
      <div>
        <label htmlFor={`${p.idPrefix}-caption`} className={labelCls}>
          Caption (optional)
        </label>
        <input id={`${p.idPrefix}-caption`} value={p.caption ?? ""} maxLength={200} onChange={(e) => p.onField("caption", e.target.value)} className={selectCls} />
      </div>

      {p.sizeChoice}

      <Group title="Size">
        <div className="grid grid-cols-2 gap-3">
          <NumberField id={`${p.idPrefix}-w`} label="Width" value={d.displayWidth} min={LIMITS.imageSide[0]} max={LIMITS.imageSide[1]} placeholder={iw ? String(iw) : "Auto"} onChange={setWidth} hint="Never wider than the space it sits in" />
          <NumberField id={`${p.idPrefix}-h`} label="Height" value={shownHeight} min={LIMITS.imageSide[0]} max={LIMITS.imageSide[1]} placeholder={ih ? String(ih) : "Auto"} onChange={setHeight} />
        </div>
        <Check
          id={`${p.idPrefix}-lock`}
          label="Keep the proportions"
          checked={lock}
          onChange={(v) => {
            setLock(v);
            if (v) p.patch({ displayHeight: undefined });
          }}
          hint={lock ? "Height follows the width." : "Width and height are fixed; the picture is cropped or letterboxed to fit."}
        />
        {!lock && (
          <SelectField
            id={`${p.idPrefix}-fit`}
            label="Fit inside the box"
            value={d.fit}
            options={[
              { value: "cover", label: "Fill the box (may crop)" },
              { value: "contain", label: "Show all of the picture" },
            ]}
            onChange={(v) => p.patch({ fit: v })}
            defaultLabel="Fill the box (may crop)"
          />
        )}
        <Button size="sm" variant="outline" onClick={() => p.patch({ displayWidth: undefined, displayHeight: undefined, fit: undefined })}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Original size
        </Button>
      </Group>

      <Group title="Position">
        <AlignButtons testId="image-align" label="Alignment" value={d.align} onChange={(a) => p.patch({ align: a })} />
        {p.allowWrap && (
          <SelectField
            id={`${p.idPrefix}-wrap`}
            label="Text around the image"
            value={d.wrap}
            options={[
              { value: "none", label: "Image on its own line" },
              { value: "left", label: "Image on the left, text wraps on the right" },
              { value: "right", label: "Image on the right, text wraps on the left" },
            ]}
            onChange={(v) => p.patch({ wrap: v === undefined || v === "none" ? undefined : v })}
            defaultLabel="Image on its own line"
          />
        )}
        {p.allowWrap && <p className="text-xs text-slate-400">On phones the image always sits on its own line, so the text stays readable.</p>}
      </Group>

      <Group title="Corners and border" open={false}>
        <div className="grid grid-cols-2 gap-3">
          <NumberField id={`${p.idPrefix}-radius`} label="Corner radius" value={d.radius} min={LIMITS.radius[0]} max={LIMITS.radius[1]} placeholder="Default" onChange={(v) => p.patch({ radius: v })} />
          <NumberField id={`${p.idPrefix}-bw`} label="Border width" value={d.borderWidth} min={LIMITS.borderWidth[0]} max={LIMITS.borderWidth[1]} placeholder="Default" onChange={(v) => p.patch({ borderWidth: v })} />
        </div>
        <ColourField id={`${p.idPrefix}-bc`} label="Border colour" value={d.borderColor} fallback="#e2e8f0" fallbackLabel="Default" onChange={(v) => p.patch({ borderColor: v })} />
      </Group>
    </div>
  );
}
