import { Fragment, type CSSProperties, type ReactNode } from "react";
import { isExternalHref, richAlign, richBlock, type Align, type BlockProps, type Color, type RichValue, type Run, type Size } from "@/lib/site-content/rich";
import { FONT_STACK } from "@/lib/site-content/styles";
import type { EdAttrs } from "@/components/marketing/cms-edit";

// Turns validated rich text (see lib/site-content/rich.ts) into React elements. Plain values render as the bare string, exactly
// as before rich text existed, so unformatted content produces byte-identical HTML. Every class is a fixed literal below
// (nothing user-supplied reaches a class, style or attribute except a validated link destination and the alignment keyword),
// and nothing is ever injected as HTML.

export const COLOR_CLASS: Record<Color, string> = {
  brand: "text-indigo-600",
  navy: "text-indigo-900",
  muted: "text-slate-500",
  success: "text-green-700",
  warning: "text-amber-700",
  danger: "text-red-700",
};
export const SIZE_CLASS: Record<Size, string> = { sm: "text-sm", lg: "text-lg", xl: "text-xl" };

// How one run looks. Legacy palette keys and named sizes keep their fixed classes (so existing content renders as before); hex
// colours, highlights, numeric sizes and fonts become inline style values built from validated data, never from free text.
export function runLook(r: Run): { className?: string; style?: CSSProperties } {
  const classes: string[] = [];
  const style: CSSProperties = {};
  if (r.color) {
    if (r.color.startsWith("#")) style.color = r.color;
    else classes.push(COLOR_CLASS[r.color as Color] ?? "");
  }
  if (r.bg) {
    style.backgroundColor = r.bg;
    style.boxDecorationBreak = "clone";
    style.padding = "0 0.15em";
    style.borderRadius = "0.2em";
  }
  if (typeof r.size === "number") style.fontSize = `${r.size / 16}rem`;
  else if (r.size) classes.push(SIZE_CLASS[r.size]);
  if (r.font) style.fontFamily = FONT_STACK[r.font];
  const className = classes.filter(Boolean).join(" ");
  return { ...(className ? { className } : {}), ...(Object.keys(style).length ? { style } : {}) };
}

export function renderRuns(runs: readonly Run[]): ReactNode[] {
  return runs.map((r, i) => {
    let node: ReactNode = r.text;
    const look = runLook(r);
    if (look.className || look.style) node = <span className={look.className} style={look.style}>{node}</span>;
    if (r.u) node = <u>{node}</u>;
    if (r.i) node = <em>{node}</em>;
    if (r.b) node = <strong>{node}</strong>;
    if (r.href) {
      const external = isExternalHref(r.href);
      node = (
        <a href={r.href} className="rounded-sm font-semibold underline underline-offset-2 hover:opacity-80 focus-ring" {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
          {node}
        </a>
      );
    }
    return <Fragment key={i}>{node}</Fragment>;
  });
}

// A string stays a string. Formatted runs render as inline elements (strong, em, u, span, a) only where a mark is set.
export function renderRich(v: RichValue): ReactNode {
  if (typeof v === "string") return v;
  return renderRuns(v.runs);
}

type Tag = "p" | "h2" | "h3" | "span" | "div";

// Block-level look: alignment, line height and the space after the paragraph. Absent properties add nothing.
export function blockStyle(align: Align | undefined, block: BlockProps): CSSProperties | undefined {
  const o: CSSProperties = {};
  if (align) o.textAlign = align;
  if (block.lineHeight !== undefined) o.lineHeight = block.lineHeight;
  if (block.spaceAfter !== undefined) o.marginBottom = `${block.spaceAfter}px`;
  if (block.spaceBefore !== undefined) o.marginTop = `${block.spaceBefore}px`;
  if (block.padX !== undefined) {
    o.paddingLeft = `${block.padX}px`;
    o.paddingRight = `${block.padX}px`;
  }
  if (block.boxWidth !== undefined) o.maxWidth = `${block.boxWidth}%`;
  if (block.boxAlign) {
    o.marginLeft = block.boxAlign === "left" ? 0 : "auto";
    o.marginRight = block.boxAlign === "right" ? 0 : "auto";
  }
  return Object.keys(o).length ? o : undefined;
}

export function RichP({ value, className, attrs, as }: { value: RichValue; className?: string; attrs?: EdAttrs; as?: Tag }) {
  const Tag = as ?? "p";
  return (
    <Tag className={className} style={blockStyle(richAlign(value), richBlock(value))} {...attrs}>
      {renderRich(value)}
    </Tag>
  );
}

// Same, for a list of runs that is always in run form (block text of added sections).
export function RunsP({ runs, align, block, className, attrs, as }: { runs: readonly Run[]; align?: Align; block?: BlockProps; className?: string; attrs?: EdAttrs; as?: Tag }) {
  const Tag = as ?? "p";
  return (
    <Tag className={className} style={blockStyle(align, block ?? {})} {...attrs}>
      {renderRuns(runs)}
    </Tag>
  );
}
