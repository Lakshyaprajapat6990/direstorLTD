"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { runLook } from "@/components/marketing/RichText";
import { HEX } from "@/lib/site-content/colour";
import { COLORS, FONTS, MAX_FONT_PX, MIN_FONT_PX, SIZES, normalizeRuns, selectionState, toggleMark, type FontKey, type Run, type Size } from "@/lib/site-content/rich";
import { cn } from "@/lib/cn";
import { useHistory } from "./history";

// A small rich-text editor for the website editor. It is a contenteditable element, but the document it edits is NOT HTML: it is
// the validated list of runs (rich.ts). The element is rebuilt from runs with createElement/textContent (never innerHTML),
// every change is read back into runs (anything the browser adds that is not a known mark is dropped), paste is plain text only,
// and Enter and drag-and-drop are blocked. The formatting toolbar acts on the active editor through the handle below.

export interface Range {
  start: number;
  end: number;
}

export interface EditorHandle {
  state(): ReturnType<typeof selectionState> & { collapsed: boolean };
  getRange(): Range | null;
  // Applies `fn` to the text range (default: the current selection, or the last selection this editor had when focus has moved to
  // the toolbar, or the word at the cursor when nothing is selected). With `restore: false` the focus stays where it is (a number box).
  apply(fn: (runs: Run[], range: Range) => Run[], range?: Range, opts?: { restore?: boolean }): boolean;
  focus(): void;
}

interface ToolbarCtx {
  active: EditorHandle | null;
  setActive(h: EditorHandle | null): void;
  clearIf(h: EditorHandle): void;
  tick: number;
}
const Ctx = createContext<ToolbarCtx>({ active: null, setActive: () => {}, clearIf: () => {}, tick: 0 });
export const useToolbar = () => useContext(Ctx);

// Holds which editor the toolbar acts on, and re-renders the toolbar when the selection moves.
export function ToolbarProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<EditorHandle | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, []);
  const value = useMemo(() => ({ active, setActive, clearIf: (h: EditorHandle) => setActive((cur) => (cur === h ? null : cur)), tick }), [active, tick]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---- runs <-> DOM ---------------------------------------------------------------------------------------------------------------

function buildDom(runs: readonly Run[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const r of runs) {
    let node: Node = document.createTextNode(r.text);
    const wrap = (tag: string, setup?: (el: HTMLElement) => void) => {
      const el = document.createElement(tag);
      setup?.(el);
      el.appendChild(node);
      node = el;
    };
    if (r.color || r.bg || r.size || r.font) {
      wrap("span", (el) => {
        const look = runLook(r);
        if (look.className) el.className = look.className;
        if (look.style) Object.assign(el.style, look.style);
        if (r.color) el.dataset.color = r.color;
        if (r.bg) el.dataset.bg = r.bg;
        if (r.size) el.dataset.size = String(r.size);
        if (r.font) el.dataset.font = r.font;
      });
    }
    if (r.u) wrap("u");
    if (r.i) wrap("em");
    if (r.b) wrap("strong");
    if (r.href) {
      const href = r.href;
      wrap("a", (el) => {
        el.dataset.href = href;
        el.className = "underline underline-offset-2 text-indigo-700";
      });
    }
    frag.appendChild(node);
  }
  return frag;
}

const LINE_BREAKS = new RegExp("[\r\n\u2028\u2029]+", "g");

type Marks = Partial<Pick<Run, "b" | "i" | "u" | "color" | "bg" | "size" | "font" | "href">>;

function domToRuns(root: Node): Run[] {
  const runs: Run[] = [];
  const walk = (node: Node, marks: Marks) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? "").replace(LINE_BREAKS, " ");
      if (t) runs.push({ text: t, ...marks });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const next: Marks = { ...marks };
    switch (el.tagName) {
      case "B":
      case "STRONG":
        next.b = true;
        break;
      case "I":
      case "EM":
        next.i = true;
        break;
      case "U":
        next.u = true;
        break;
      case "A": {
        const h = el.dataset.href ?? el.getAttribute("href");
        if (h) next.href = h;
        break;
      }
      case "SPAN": {
        const { color: c, bg, size: z, font: f } = el.dataset;
        if (c && ((COLORS as readonly string[]).includes(c) || HEX.test(c))) next.color = c;
        if (bg && HEX.test(bg)) next.bg = bg;
        if (z && (SIZES as readonly string[]).includes(z)) next.size = z as Size;
        else if (z && /^\d{1,3}$/.test(z) && +z >= MIN_FONT_PX && +z <= MAX_FONT_PX) next.size = +z;
        if (f && (FONTS as readonly string[]).includes(f)) next.font = f as FontKey;
        break;
      }
      case "BR":
        return;
    }
    el.childNodes.forEach((c) => walk(c, next));
  };
  root.childNodes.forEach((c) => walk(c, {}));
  return normalizeRuns(runs, false);
}

function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, offset);
  return r.toString().length;
}

function readRange(root: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const rg = sel.getRangeAt(0);
  if (!root.contains(rg.startContainer) || !root.contains(rg.endContainer)) return null;
  const a = offsetOf(root, rg.startContainer, rg.startOffset);
  const b = offsetOf(root, rg.endContainer, rg.endOffset);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}

function locate(root: HTMLElement, pos: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let n = walker.nextNode();
  while (n) {
    const len = (n.textContent ?? "").length;
    if (pos <= acc + len) return { node: n, offset: pos - acc };
    acc += len;
    n = walker.nextNode();
  }
  return { node: root, offset: root.childNodes.length };
}

function writeRange(root: HTMLElement, start: number, end: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const s = locate(root, start);
  const e = locate(root, end);
  const r = document.createRange();
  r.setStart(s.node, s.offset);
  r.setEnd(e.node, e.offset);
  sel.removeAllRanges();
  sel.addRange(r);
}

function wordAt(text: string, pos: number): Range {
  let start = pos;
  let end = pos;
  while (start > 0 && /\S/.test(text[start - 1])) start--;
  while (end < text.length && /\S/.test(text[end])) end++;
  return { start, end };
}

const stable = (runs: readonly Run[]) => JSON.stringify(runs.map((r) => Object.keys(r).sort().map((k) => [k, (r as unknown as Record<string, unknown>)[k]])));

// ---- the component ------------------------------------------------------------------------------------------------------------

export function RunEditor({ runs, onChange, label, id, placeholder, invalid, describedBy, autoFocus }: { runs: Run[]; onChange: (runs: Run[]) => void; label: string; id?: string; placeholder?: string; invalid?: boolean; describedBy?: string; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const lastKey = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const toolbar = useToolbar();
  const history = useHistory();
  const historyRef = useRef(history);
  historyRef.current = history;
  // The last selection inside this editor. The toolbar's selects, number boxes and colour picker take focus, which can clear the
  // browser's selection; formatting then still applies to the words that were selected.
  const lastRange = useRef<Range | null>(null);
  const key = stable(runs);

  // Rebuild the element only when the incoming runs differ from what the element already shows (so typing keeps its cursor).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || key === lastKey.current) return;
    el.replaceChildren(buildDom(runs));
    lastKey.current = key;
  }, [key, runs]);

  const handle = useMemo<EditorHandle>(() => {
    const el = () => ref.current as HTMLDivElement;
    const emit = (next: Run[]) => {
      lastKey.current = stable(next);
      onChangeRef.current(next);
    };
    const current = (e: HTMLElement) => readRange(e) ?? lastRange.current;
    return {
      getRange: () => current(el()),
      state() {
        const e = el();
        const cur = current(e) ?? { start: 0, end: 0 };
        const text = e.textContent ?? "";
        const r = cur.start === cur.end ? wordAt(text, cur.start) : cur;
        return { ...selectionState(domToRuns(e), r.start, r.end), collapsed: cur.start === cur.end };
      },
      apply(fn, range, opts) {
        const e = el();
        const cur = range ?? current(e) ?? { start: 0, end: 0 };
        const text = e.textContent ?? "";
        const bounded = { start: Math.min(cur.start, text.length), end: Math.min(cur.end, text.length) };
        const r = bounded.start === bounded.end ? wordAt(text, bounded.start) : bounded;
        if (r.start === r.end) return false;
        const next = fn(domToRuns(e), r);
        e.replaceChildren(buildDom(next));
        lastKey.current = stable(next);
        lastRange.current = r;
        if (opts?.restore !== false) {
          e.focus();
          writeRange(e, r.start, r.end);
        }
        emit(next);
        return true;
      },
      focus: () => el().focus(),
    };
  }, []);

  // Opened from a click on the page: put the cursor at the end of the text so typing and the toolbar work at once.
  useEffect(() => {
    const el = ref.current;
    if (!autoFocus || !el) return;
    el.focus({ preventScroll: true });
    const end = (el.textContent ?? "").length;
    writeRange(el, end, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const remember = () => {
      const r = readRange(el);
      if (r) lastRange.current = r;
    };
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, []);

  const toolbarRef = useRef(toolbar);
  toolbarRef.current = toolbar;
  useEffect(() => () => toolbarRef.current.clearIf(handle), [handle]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const block = (e: InputEvent) => {
      // No line breaks (one paragraph per editor) and no browser-made formatting: formatting goes through the toolbar.
      if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak" || e.inputType.startsWith("format")) e.preventDefault();
      // The browser's own undo cannot follow the rebuilt content; the editor's history (text, formatting and structure) does.
      if (e.inputType === "historyUndo") {
        e.preventDefault();
        historyRef.current.undo();
      }
      if (e.inputType === "historyRedo") {
        e.preventDefault();
        historyRef.current.redo();
      }
    };
    el.addEventListener("beforeinput", block);
    return () => el.removeEventListener("beforeinput", block);
  }, []);

  const read = () => {
    const el = ref.current;
    if (!el) return;
    const next = domToRuns(el);
    lastKey.current = stable(next);
    onChangeRef.current(next);
  };

  return (
    <div
      ref={ref}
      id={id}
      role="textbox"
      aria-label={label}
      aria-multiline="false"
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder={placeholder ?? "Type here"}
      className={cn("min-h-[2.5rem] w-full rounded-lg border bg-white px-3 py-2 text-sm leading-relaxed text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 empty:before:text-slate-400 empty:before:content-[attr(data-placeholder)]", invalid ? "border-red-400" : "border-slate-300")}
      onFocus={() => toolbar.setActive(handle)}
      onInput={read}
      onDrop={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
        const mod = e.ctrlKey || e.metaKey;
        if (mod && !e.altKey && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) history.redo();
          else history.undo();
          return;
        }
        if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "y") {
          e.preventDefault();
          history.redo();
          return;
        }
        if (mod && !e.shiftKey && !e.altKey && ["b", "i", "u"].includes(e.key.toLowerCase())) {
          e.preventDefault();
          const mark = e.key.toLowerCase() as "b" | "i" | "u";
          handle.apply((rs, rg) => toggleMark(rs, rg.start, rg.end, mark));
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        const text = e.clipboardData.getData("text/plain").replace(/\s*[\r\n]+\s*/g, " ");
        const sel = window.getSelection();
        if (!text || !sel || sel.rangeCount === 0) return;
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        read();
      }}
    />
  );
}
