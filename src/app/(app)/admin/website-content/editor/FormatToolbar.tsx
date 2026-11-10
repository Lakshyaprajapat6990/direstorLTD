"use client";

import { useState } from "react";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Eraser, Highlighter, ImagePlus, Italic, Link2, List, ListOrdered, Minus, Plus, Redo2, Type, Underline, Undo2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { isHex } from "@/lib/site-content/colour";
import { FONTS, INTERNAL_LINKS, LINE_HEIGHT_RANGE, MAX_FONT_PX, MIN_FONT_PX, SPACE_AFTER_RANGE, clearFormatting, setMark, sizePx, toggleMark, validateHref, type Align, type BlockProps, type FontKey } from "@/lib/site-content/rich";
import { FONT_LABEL } from "@/lib/site-content/styles";
import { ColourPanel, useColourMemory } from "./ColourPicker";
import { useHistory } from "./history";
import { useToolbar, type Range } from "./RunEditor";

// The formatting toolbar, in three rows: history and type; emphasis, colour and links; paragraph layout. It acts on whichever text
// editor was last used (see RunEditor) and on the selection that editor remembers, so using a select, a number box or the colour
// picker does not lose the selected words. Everything it can set is a fixed list, a bounded number or a hex colour: no free-form CSS.

const keep = (e: { preventDefault(): void }) => e.preventDefault();
const LINE_HEIGHTS = [1, 1.15, 1.3, 1.5, 1.75, 2, 2.5];

function Btn({ label, on, onClick, disabled, children, testId }: { label: string; on?: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={on === undefined ? undefined : on} data-testid={testId} disabled={disabled} onMouseDown={keep} onClick={onClick} className={cn("flex h-8 w-8 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 focus-ring disabled:opacity-40", on && "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200")}>
      {children}
    </button>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
    {children}
  </div>
);
const Sep = () => <span className="mx-0.5 h-5 w-px bg-slate-200" aria-hidden />;

export type BlockKind = "p" | "h2" | "h3" | "ul" | "ol";

export interface ToolbarProps {
  align?: Align;
  onAlign?: (a: Align | undefined) => void;
  // Line height and the space after the paragraph (the whole paragraph, not the selection).
  block?: BlockProps;
  onBlock?: (patch: BlockProps) => void;
  // Paragraph / heading / list, where the text belongs to a block that can change kind.
  kind?: BlockKind;
  onKind?: (k: BlockKind) => void;
  // Insert a picture below this block (only where the text belongs to a block in a text section).
  onImage?: () => void;
}

export function FormatToolbar({ align, onAlign, block, onBlock, kind, onKind, onImage }: ToolbarProps) {
  const { active } = useToolbar();
  const history = useHistory();
  const memory = useColourMemory();
  const [panel, setPanel] = useState<null | "color" | "bg" | "link">(null);
  const [linkRange, setLinkRange] = useState<Range | null>(null);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);

  let st: ReturnType<NonNullable<typeof active>["state"]> | null = null;
  try {
    st = active?.state() ?? null;
  } catch {
    st = null;
  }
  const off = !active || !st;
  const px = sizePx(st?.size);
  const colour = st?.color && isHex(st.color) ? st.color : undefined;

  const run = (fn: Parameters<NonNullable<typeof active>["apply"]>[0], range?: Range, restore = true) => active?.apply(fn, range, { restore });

  const openLink = () => {
    if (!active) return;
    setLinkRange(active.getRange());
    setLinkValue(st?.href ?? "");
    setLinkError(null);
    setPanel("link");
  };
  const applyLink = () => {
    const href = linkValue.trim();
    const bad = validateHref(href);
    if (bad) return setLinkError(bad);
    run((rs, rg) => setMark(rs, rg.start, rg.end, { href }), linkRange ?? undefined);
    setPanel(null);
  };
  const setSize = (n: number | undefined) => run((rs, rg) => setMark(rs, rg.start, rg.end, n === undefined ? { clear: ["size"] } : { size: n }), undefined, false);
  const alignBtn = (a: Align, label: string, Icon: typeof AlignLeft) => (
    <Btn key={a} label={label} testId={`align-${a}`} on={align === a} disabled={!onAlign} onClick={() => onAlign?.(align === a ? undefined : a)}>
      <Icon className="h-4 w-4" aria-hidden />
    </Btn>
  );

  return (
    <div role="toolbar" aria-label="Text formatting" data-testid="format-toolbar" className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-1.5">
      {/* Row 1: history, text style, font and size */}
      <Row label="History, style, font and size">
        <Btn label="Undo (Ctrl+Z)" testId="undo" disabled={!history.canUndo} onClick={history.undo}>
          <Undo2 className="h-4 w-4" aria-hidden />
        </Btn>
        <Btn label="Redo (Ctrl+Y)" testId="redo" disabled={!history.canRedo} onClick={history.redo}>
          <Redo2 className="h-4 w-4" aria-hidden />
        </Btn>
        <Sep />
        {onKind && kind && (
          <>
            <label className="sr-only" htmlFor="fmt-kind">
              Paragraph style
            </label>
            <select id="fmt-kind" data-testid="fmt-kind" value={kind} onChange={(e) => onKind(e.target.value as BlockKind)} className="h-8 rounded-md border border-slate-200 bg-white px-1.5 text-xs text-slate-700 focus-ring">
              <option value="p">Paragraph</option>
              <option value="h2">Heading</option>
              <option value="h3">Sub-heading</option>
              <option value="ul" disabled>
                Bullet list
              </option>
              <option value="ol" disabled>
                Numbered list
              </option>
            </select>
          </>
        )}
        <label className="sr-only" htmlFor="fmt-font">
          Font
        </label>
        <select id="fmt-font" data-testid="fmt-font" disabled={off} value={st?.font ?? ""} onChange={(e) => { const v = e.target.value as FontKey | ""; run((rs, rg) => setMark(rs, rg.start, rg.end, v ? { font: v } : { clear: ["font"] })); }} className="h-8 max-w-[7.5rem] rounded-md border border-slate-200 bg-white px-1.5 text-xs text-slate-700 focus-ring disabled:opacity-40">
          <option value="">Default font</option>
          {FONTS.map((f) => (
            <option key={f} value={f}>
              {FONT_LABEL[f]}
            </option>
          ))}
        </select>
        <div role="group" aria-label="Font size" className="flex items-center">
          <Btn label="Smaller text" testId="size-down" disabled={off} onClick={() => setSize(Math.max(MIN_FONT_PX, (px ?? 16) - 1))}>
            <Minus className="h-3.5 w-3.5" aria-hidden />
          </Btn>
          <label className="sr-only" htmlFor="fmt-size">
            Font size in pixels
          </label>
          <input
            id="fmt-size"
            data-testid="fmt-size"
            type="number"
            inputMode="numeric"
            min={MIN_FONT_PX}
            max={MAX_FONT_PX}
            step={1}
            disabled={off}
            placeholder="Auto"
            value={px ?? ""}
            onChange={(e) => {
              if (e.target.value === "") return setSize(undefined);
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= MIN_FONT_PX && n <= MAX_FONT_PX) setSize(n);
            }}
            className="h-8 w-14 rounded-md border border-slate-200 bg-white px-1.5 text-center text-xs text-slate-700 focus-ring disabled:opacity-40"
          />
          <Btn label="Larger text" testId="size-up" disabled={off} onClick={() => setSize(Math.min(MAX_FONT_PX, (px ?? 16) + 1))}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </Btn>
        </div>
      </Row>

      {/* Row 2: emphasis, colours, link */}
      <Row label="Emphasis, colour and link">
        <Btn label="Bold (Ctrl+B)" testId="bold" on={st?.b} disabled={off} onClick={() => run((rs, rg) => toggleMark(rs, rg.start, rg.end, "b"))}>
          <Bold className="h-4 w-4" aria-hidden />
        </Btn>
        <Btn label="Italic (Ctrl+I)" testId="italic" on={st?.i} disabled={off} onClick={() => run((rs, rg) => toggleMark(rs, rg.start, rg.end, "i"))}>
          <Italic className="h-4 w-4" aria-hidden />
        </Btn>
        <Btn label="Underline (Ctrl+U)" testId="underline" on={st?.u} disabled={off} onClick={() => run((rs, rg) => toggleMark(rs, rg.start, rg.end, "u"))}>
          <Underline className="h-4 w-4" aria-hidden />
        </Btn>
        <Sep />
        <button type="button" title="Text colour" aria-label="Text colour" aria-expanded={panel === "color"} data-testid="text-colour" disabled={off} onMouseDown={keep} onClick={() => setPanel(panel === "color" ? null : "color")} className={cn("flex h-8 items-center gap-1 rounded-md px-2 text-slate-600 hover:bg-slate-100 focus-ring disabled:opacity-40", (panel === "color" || st?.color) && "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200")}>
          <Type className="h-4 w-4" aria-hidden />
          <span className="h-1.5 w-4 rounded-sm border border-slate-300" style={{ backgroundColor: colour ?? "transparent" }} aria-hidden />
        </button>
        <button type="button" title="Highlight colour" aria-label="Highlight colour" aria-expanded={panel === "bg"} data-testid="highlight-colour" disabled={off} onMouseDown={keep} onClick={() => setPanel(panel === "bg" ? null : "bg")} className={cn("flex h-8 items-center gap-1 rounded-md px-2 text-slate-600 hover:bg-slate-100 focus-ring disabled:opacity-40", (panel === "bg" || st?.bg) && "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200")}>
          <Highlighter className="h-4 w-4" aria-hidden />
          <span className="h-1.5 w-4 rounded-sm border border-slate-300" style={{ backgroundColor: st?.bg ?? "transparent" }} aria-hidden />
        </button>
        <Sep />
        <Btn label="Add or edit link" testId="link" on={!!st?.href} disabled={off} onClick={openLink}>
          <Link2 className="h-4 w-4" aria-hidden />
        </Btn>
        {onImage && (
          <button type="button" title="Insert image below this block" aria-label="Insert image" data-testid="toolbar-image" onMouseDown={keep} onClick={onImage} className="ml-1 flex h-8 items-center gap-1 rounded-md bg-indigo-50 px-2 text-xs font-semibold text-indigo-700 ring-1 ring-indigo-200 hover:bg-indigo-100 focus-ring">
            <ImagePlus className="h-4 w-4" aria-hidden /> Image
          </button>
        )}
        <Btn label="Clear formatting" testId="clear-format" disabled={off} onClick={() => run((rs, rg) => clearFormatting(rs, rg.start, rg.end))}>
          <Eraser className="h-4 w-4" aria-hidden />
        </Btn>
      </Row>

      {/* Row 3: paragraph layout */}
      <Row label="Paragraph layout">
        {alignBtn("left", "Align left", AlignLeft)}
        {alignBtn("center", "Align centre", AlignCenter)}
        {alignBtn("right", "Align right", AlignRight)}
        {alignBtn("justify", "Justify", AlignJustify)}
        {onKind && (
          <>
            <Sep />
            <Btn label="Bulleted list" testId="list-ul" on={kind === "ul"} onClick={() => onKind(kind === "ul" ? "p" : "ul")}>
              <List className="h-4 w-4" aria-hidden />
            </Btn>
            <Btn label="Numbered list" testId="list-ol" on={kind === "ol"} onClick={() => onKind(kind === "ol" ? "p" : "ol")}>
              <ListOrdered className="h-4 w-4" aria-hidden />
            </Btn>
          </>
        )}
        {onBlock && (
          <>
            <Sep />
            <label className="sr-only" htmlFor="fmt-lh">
              Line height
            </label>
            <select id="fmt-lh" data-testid="fmt-lh" value={block?.lineHeight ?? ""} onChange={(e) => onBlock({ lineHeight: e.target.value ? Number(e.target.value) : undefined })} className="h-8 rounded-md border border-slate-200 bg-white px-1.5 text-xs text-slate-700 focus-ring" title={`Line height (${LINE_HEIGHT_RANGE[0]} to ${LINE_HEIGHT_RANGE[1]})`}>
              <option value="">Line height</option>
              {LINE_HEIGHTS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="fmt-space">
              Space after paragraph in pixels
            </label>
            <input id="fmt-space" data-testid="fmt-space" type="number" inputMode="numeric" min={SPACE_AFTER_RANGE[0]} max={SPACE_AFTER_RANGE[1]} step={4} placeholder="Space" title={`Space after the paragraph, ${SPACE_AFTER_RANGE[0]} to ${SPACE_AFTER_RANGE[1]} px`} value={block?.spaceAfter ?? ""} onChange={(e) => {
              if (e.target.value === "") return onBlock({ spaceAfter: undefined });
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= SPACE_AFTER_RANGE[0] && n <= SPACE_AFTER_RANGE[1]) onBlock({ spaceAfter: n });
            }} className="h-8 w-16 rounded-md border border-slate-200 bg-white px-1.5 text-center text-xs text-slate-700 focus-ring" />
          </>
        )}
      </Row>

      {panel === "color" && (
        <ColourPanel
          idPrefix="tb-colour"
          value={colour}
          fallback="#64748b"
          onChange={(hex) => run((rs, rg) => setMark(rs, rg.start, rg.end, { color: hex }), undefined, false)}
          onCommit={(hex) => memory.remember(hex)}
          onReset={() => run((rs, rg) => setMark(rs, rg.start, rg.end, { clear: ["color"] }))}
          against={st?.bg ?? "#ffffff"}
          againstWhat="text"
          comboWith={{ role: "text", other: st?.bg }}
        />
      )}
      {panel === "bg" && (
        <ColourPanel
          idPrefix="tb-highlight"
          value={st?.bg}
          fallback="#fef08a"
          onChange={(hex) => run((rs, rg) => setMark(rs, rg.start, rg.end, { bg: hex }), undefined, false)}
          onCommit={(hex) => memory.remember(hex)}
          onReset={() => run((rs, rg) => setMark(rs, rg.start, rg.end, { clear: ["bg"] }))}
          against={colour ?? "#334155"}
          againstWhat="text"
          comboWith={{ role: "bg", other: colour }}
        />
      )}
      {panel === "link" && (
        <div className="w-full space-y-2 rounded-lg border border-indigo-200 bg-white p-3 shadow-sm" role="group" aria-label="Link">
          <label className="block text-xs font-medium text-slate-600" htmlFor="link-page">
            Link to a page of this site
          </label>
          <select id="link-page" value={INTERNAL_LINKS.some((l) => l.href === linkValue) ? linkValue : ""} onChange={(e) => { setLinkValue(e.target.value); setLinkError(null); }} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus-ring">
            <option value="">Choose a page…</option>
            {INTERNAL_LINKS.map((l) => (
              <option key={l.href} value={l.href}>
                {l.label}
              </option>
            ))}
          </select>
          <label className="block text-xs font-medium text-slate-600" htmlFor="link-url">
            …or a web address (https://) or email (mailto:)
          </label>
          <input id="link-url" value={linkValue} onChange={(e) => { setLinkValue(e.target.value); setLinkError(null); }} placeholder="https://example.com" className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus-ring" />
          {linkError && (
            <p role="alert" className="text-xs text-red-700">
              {linkError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={applyLink} className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 focus-ring">
              Apply link
            </button>
            {st?.href && (
              <button type="button" onClick={() => { run((rs, rg) => setMark(rs, rg.start, rg.end, { clear: ["href"] }), linkRange ?? undefined); setPanel(null); }} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-ring">
                Remove link
              </button>
            )}
            <button type="button" onClick={() => setPanel(null)} className="rounded-md px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 focus-ring">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
