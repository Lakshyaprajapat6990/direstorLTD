"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eye, History, Maximize2, Megaphone, Minimize2, Monitor, Plus, Redo2, Save, Send, Smartphone, Tablet, Type, LayoutGrid, HelpCircle, Undo2, Image as ImageIcon, Video as VideoIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { CmsState } from "@/lib/site-content/store";
import type { EditableContent } from "@/lib/site-content/schema";
import { asFromCanvas, type ToCanvas } from "@/lib/site-content/editor-protocol";
import { addCustomSection, currentOrder, duplicateSection, moveSection, moveSectionBy, newImageBlock, newSection, patchCustom, pruneEmptyOptionals, removeCustomSection, resetOrder, setCardImage, setIn, type NewSectionInput, type Path } from "@/lib/site-content/editor-model";
import { customKey, isBuiltinKey, sectionInfo, type CardImageTarget, type OrderKey } from "@/lib/site-content/styles";
import { SECTION_TYPES, SLOTS, parseVideoUrl, type SlotId } from "@/lib/site-content/sections";
import type { MediaDTO } from "@/lib/site-content/media-store";
import { ColourMemoryProvider } from "./editor/ColourPicker";
import { ConfirmDialog, Dialog } from "./editor/Dialog";
import { HistoryProvider, useUndoStack } from "./editor/history";
import { Inspector } from "./editor/Inspector";
import { MediaPicker } from "./editor/MediaPicker";
import { ToolbarProvider } from "./editor/RunEditor";

type Msg = { tone: "ok" | "error" | "warn"; text: string; undo?: boolean } | null;
interface Issue {
  path: string;
  message: string;
}

const DEVICES = {
  desktop: { width: 1280, label: "Desktop", Icon: Monitor },
  tablet: { width: 768, label: "Tablet", Icon: Tablet },
  mobile: { width: 375, label: "Mobile", Icon: Smartphone },
} as const;
type DeviceId = keyof typeof DEVICES;

const TYPE_ICON = { text: Type, image: ImageIcon, video: VideoIcon, cta: Megaphone, cards: LayoutGrid, faq: HelpCircle } as const;

const fmt = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "—");

async function call(url: string, method: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: Record<string, unknown> = {};
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

const insertionIndex = (list: EditableContent["custom"], slot: SlotId) => {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].slot === slot) return i + 1;
  return list.length;
};

type Picker = null | { kind: "card"; target: CardImageTarget } | { kind: "new"; slot: SlotId } | { kind: "change"; index: number } | { kind: "block"; section: number; block: number | null; after?: number };

export function VisualEditor({ initial }: { initial: CmsState }) {
  const [state, setState] = useState<CmsState>(initial);
  const [content, setContent] = useState<EditableContent>(initial.editing);
  const [saved, setSaved] = useState<string>(JSON.stringify(initial.editing));
  const [selected, setSelected] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceId>("desktop");
  const [fullscreen, setFullscreen] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [dialog, setDialog] = useState<null | "publish" | "history" | "add" | "discard">(null);
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [addSlot, setAddSlot] = useState<SlotId>("beforeFaq");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoError, setVideoError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pane, setPane] = useState({ w: 900, h: 700 });

  const iframe = useRef<HTMLIFrameElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  const history = useUndoStack(content, setContent);
  const dirty = useMemo(() => JSON.stringify(content) !== saved, [content, saved]);
  const errors = useMemo(() => new Map(issues.map((i) => [i.path, i.message])), [issues]);

  // ---- talking to the canvas -----------------------------------------------------------------------------------------------
  const post = useCallback((m: ToCanvas) => iframe.current?.contentWindow?.postMessage(m, window.location.origin), []);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== iframe.current?.contentWindow) return;
      const m = asFromCanvas(e.data);
      if (!m) return;
      if (m.type === "cms:ready") setReady(true);
      else if (m.type === "cms:select") {
        setSelected(m.path);
        setLocked(null);
      } else {
        setLocked(m.reason);
        setSelected(null);
      }
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);

  useEffect(() => {
    if (ready) post({ type: "cms:content", content });
  }, [ready, content, post]);

  // Until the canvas has answered once, keep offering it the content (it may have loaded before this page finished hydrating).
  useEffect(() => {
    if (ready) return;
    const t = setInterval(() => post({ type: "cms:content", content }), 400);
    return () => clearInterval(t);
  }, [ready, content, post]);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setPane({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fullscreen]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const { boundary } = history;
  const select = useCallback(
    (path: string | null, scroll = false) => {
      boundary();
      setSelected(path);
      setLocked(null);
      post({ type: "cms:select", path, scroll });
    },
    [post, boundary]
  );

  // Ctrl+Z / Ctrl+Y anywhere except inside a plain text box (which has its own undo); text editors route to the same history.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "z") {
        e.preventDefault();
        if (e.shiftKey) history.api.redo();
        else history.api.undo();
      } else if (k === "y") {
        e.preventDefault();
        history.api.redo();
      }
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [history.api]);

  // ---- editing --------------------------------------------------------------------------------------------------------------
  const update = useCallback((path: Path, value: unknown) => setContent((c) => setIn(c, path, value)), []);
  const mutate = useCallback((fn: (c: EditableContent) => EditableContent) => setContent(fn), []);

  // Section order. The page renders from content.order, so every change here shows on the canvas at once.
  const orderNow = currentOrder(content);
  const isDefaultOrder = content.order === undefined;
  const announceMove = (label: string) => setMsg({ tone: "ok", text: `${label} moved. The page on the left shows the new order.`, undo: true });
  const keyLabel = (k: OrderKey) => (isBuiltinKey(k) ? sectionInfo(k).label : "Section");
  const moveTo = (key: OrderKey, finalIndex: number) => {
    const r = moveSection(content, key, finalIndex);
    if (r.error) return setMsg({ tone: "warn", text: r.error });
    if (r.content === content) return;
    boundary();
    setContent(r.content);
    announceMove(keyLabel(key));
  };
  const onMove = (index: number, dir: -1 | 1) => {
    const key = customKey(content.custom[index].id);
    const r = moveSectionBy(content, key, dir);
    if (r.error) return setMsg({ tone: "warn", text: r.error });
    boundary();
    setContent(r.content);
    announceMove("Section");
  };
  const onResetOrder = () => {
    boundary();
    setContent(resetOrder(content));
    setMsg({ tone: "ok", text: "Every section is back in its original place.", undo: true });
  };
  const onDuplicate = (index: number) => {
    const copy = duplicateSection(content.custom[index]);
    boundary();
    setContent(addCustomSection(content, copy, index + 1, customKey(content.custom[index].id)));
    select(`custom.${index + 1}`, true);
    setMsg({ tone: "ok", text: "Section duplicated below the original.", undo: true });
  };
  const addSection = (input: NewSectionInput, slot: SlotId) => {
    const idx = insertionIndex(content.custom, slot);
    boundary();
    setContent(addCustomSection(content, newSection(input, slot), idx));
    select(`custom.${idx}`, true);
  };

  const onPick = (m: MediaDTO) => {
    if (!picker) return;
    const alt = (m.originalName ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim().slice(0, 160) || "Image";
    if (picker.kind === "card") {
      const t = picker.target;
      boundary();
      setContent((c) => setCardImage(c, t, { mediaId: m.id, alt: alt.slice(0, 160) }));
      setMsg({ tone: "ok", text: "Picture set. Describe it for screen readers in the panel on the right." });
    } else if (picker.kind === "new") {
      addSection({ type: "image", mediaId: m.id, alt, width: m.width, height: m.height }, picker.slot);
      setMsg({ tone: "ok", text: "Image added. Describe it for screen readers in the panel on the right." });
    } else if (picker.kind === "change") {
      const i = picker.index;
      boundary();
      setContent((c) => patchCustom(c, i, { mediaId: m.id, width: m.width, height: m.height }));
    } else {
      const { section, block, after } = picker;
      boundary();
      if (block === null) {
        const len = (content.custom[section] as { blocks?: unknown[] } | undefined)?.blocks?.length ?? 0;
        const at = after === undefined ? len : Math.min(after + 1, len);
        setContent((c) => ({ ...c, custom: c.custom.map((x, i) => (i === section && x.type === "text" ? { ...x, blocks: [...x.blocks.slice(0, at), newImageBlock({ mediaId: m.id, alt, width: m.width, height: m.height }), ...x.blocks.slice(at)] } : x)) }));
        select(`custom.${section}.blocks.${at}`, true);
        setMsg({ tone: "ok", text: "Image added to the section. Choose its size and position in the panel." });
      } else {
        setContent((c) => ({ ...c, custom: c.custom.map((x, i) => (i === section && x.type === "text" ? { ...x, blocks: x.blocks.map((b, j) => (j === block && b.kind === "image" ? { ...b, mediaId: m.id, width: m.width, height: m.height } : b)) } : x)) }));
      }
    }
    setPicker(null);
  };

  // ---- server calls ---------------------------------------------------------------------------------------------------------
  const report = (r: { status: number; json: Record<string, unknown> }) => {
    setIssues(Array.isArray(r.json.issues) ? (r.json.issues as Issue[]) : []);
    const code = typeof r.json.code === "string" ? r.json.code : "";
    setMsg({ tone: ["version_conflict", "stale_draft", "no_changes"].includes(code) ? "warn" : "error", text: (typeof r.json.error === "string" && r.json.error) || `The request failed (${r.status}).` });
  };
  const adopt = (next: CmsState | null, keepWorking: boolean) => {
    if (!next) return;
    setState(next);
    if (!keepWorking) {
      setContent(next.editing);
      history.clear(next.editing);
      setSaved(JSON.stringify(next.editing));
    }
  };
  async function reload(keepWorking: boolean) {
    const r = await call("/api/admin/website-content", "GET");
    if (r.status === 200) adopt(r.json.state as CmsState, keepWorking);
  }

  async function saveDraft(rebase = false) {
    setBusy(true);
    setMsg(null);
    setIssues([]);
    try {
      const body = pruneEmptyOptionals(content);
      const r = await call("/api/admin/website-content/draft", "PUT", { content: body, expectedDraftVersion: state.draftVersion, ...(rebase ? { rebase: true } : {}) });
      if (r.status === 200) {
        setContent(body);
        setSaved(JSON.stringify(body));
        adopt(r.json.state as CmsState, true);
        setMsg({ tone: "ok", text: rebase ? "Draft saved and re-based onto the published version. Review it, then publish." : "Draft saved. It is not public until you publish it." });
      } else {
        report(r);
        if (r.status === 409) await reload(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function doPublish() {
    setBusy(true);
    setMsg(null);
    setIssues([]);
    try {
      const r = await call("/api/admin/website-content/publish", "POST", { expectedDraftVersion: state.draftVersion, expectedPublishedVersion: state.publishedVersion, note: note.trim() || null });
      setDialog(null);
      if (r.status === 200) {
        setNote("");
        adopt(r.json.state as CmsState, false);
        const stale = r.json.revalidated === false ? " The cache refresh failed, so the public page will update on its own schedule." : "";
        setMsg({ tone: r.json.revalidated === false ? "warn" : "ok", text: `Published as version ${r.json.version}. The public page can take up to about a minute (longer behind a CDN or on several servers) to show it.${stale}` });
      } else {
        report(r);
        if (r.status === 409) await reload(true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function doRestore(toVersion: number) {
    setBusy(true);
    setMsg(null);
    setIssues([]);
    try {
      const r = await call("/api/admin/website-content/rollback", "POST", { toVersion, expectedPublishedVersion: state.publishedVersion, note: note.trim() || null });
      setRestoreVersion(null);
      if (r.status === 200) {
        setNote("");
        adopt(r.json.state as CmsState, state.hasDraft || dirty);
        setMsg({ tone: r.json.revalidated === false ? "warn" : "ok", text: `Version ${toVersion} restored as version ${r.json.version}. The public page can take up to about a minute to show it.${state.hasDraft ? " Your saved draft is unchanged; it must be re-based before it can be published." : ""}` });
      } else {
        report(r);
        if (r.status === 409) await reload(true);
      }
    } finally {
      setBusy(false);
    }
  }

  const pill = (tone: "ok" | "warn" | "muted", text: string) => (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", tone === "ok" ? "bg-green-50 text-green-700 ring-1 ring-green-200" : tone === "warn" ? "bg-amber-50 text-amber-800 ring-1 ring-amber-200" : "bg-slate-100 text-slate-600")}>{text}</span>
  );

  const dw = DEVICES[device].width;
  const scale = Math.min(1, Math.max(0.2, (pane.w - 16) / dw));
  const canPublish = !busy && !dirty && state.hasDraft && !state.draftStale;
  const publishHint = dirty ? "Save the draft first" : !state.hasDraft ? "There is no saved draft to publish" : state.draftStale ? "Re-base the draft first" : "Publish the saved draft";
  const panelHeight = fullscreen ? "calc(100vh - 8.5rem)" : "calc(100vh - 17rem)";

  return (
    <ColourMemoryProvider>
    <HistoryProvider value={history.api}>
    <ToolbarProvider>
      <div className={cn(fullscreen ? "fixed inset-0 z-50 flex flex-col gap-3 overflow-y-auto bg-slate-100 p-3" : "space-y-3")} data-testid="visual-editor">
        {/* Top bar */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Status">
            {state.publishedVersion > 0 ? pill("ok", `Published v${state.publishedVersion}`) : pill("muted", "Built-in wording")}
            {state.hasDraft ? (state.draftStale ? pill("warn", `Draft v${state.draftVersion} (stale)`) : pill("muted", `Draft v${state.draftVersion}`)) : pill("muted", "No saved draft")}
            {dirty && pill("warn", "Unsaved changes")}
          </div>

          <div role="group" aria-label="Preview size" className="mx-auto flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            {(Object.keys(DEVICES) as DeviceId[]).map((id) => {
              const D = DEVICES[id];
              return (
                <button key={id} type="button" aria-pressed={device === id} onClick={() => setDevice(id)} className={cn("flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium focus-ring", device === id ? "bg-white text-indigo-700 shadow-sm" : "text-slate-600 hover:text-slate-900")}>
                  <D.Icon className="h-4 w-4" aria-hidden /> {D.label}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Undo and redo" className="flex items-center">
              <Button variant="ghost" size="sm" onClick={history.api.undo} disabled={!history.api.canUndo} aria-label="Undo (Ctrl+Z)" title="Undo (Ctrl+Z)" data-testid="top-undo">
                <Undo2 className="h-4 w-4" aria-hidden />
              </Button>
              <Button variant="ghost" size="sm" onClick={history.api.redo} disabled={!history.api.canRedo} aria-label="Redo (Ctrl+Y)" title="Redo (Ctrl+Y)" data-testid="top-redo">
                <Redo2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            <Button variant="outline" size="sm" onClick={() => setDialog("add")} data-testid="add-section">
              <Plus className="h-4 w-4" aria-hidden /> Add section
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDialog("history")}>
              <History className="h-4 w-4" aria-hidden /> History
            </Button>
            <a href="/website-preview" target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 focus-ring">
              <Eye className="h-4 w-4" aria-hidden /> Private preview
            </a>
            <Button variant="ghost" size="sm" onClick={() => setFullscreen((f) => !f)} aria-pressed={fullscreen}>
              {fullscreen ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />} {fullscreen ? "Exit full screen" : "Full screen"}
            </Button>
            <span className="mx-1 hidden h-6 w-px bg-slate-200 sm:block" aria-hidden />
            <Button variant="outline" onClick={() => saveDraft(false)} disabled={busy || !dirty} data-testid="save-draft">
              <Save className="h-4 w-4" aria-hidden /> Save draft
            </Button>
            <Button onClick={() => setDialog("publish")} disabled={!canPublish} title={publishHint} data-testid="publish">
              <Send className="h-4 w-4" aria-hidden /> Publish
            </Button>
          </div>
        </div>

        {state.storedIssue && (
          <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {state.storedIssue}
          </p>
        )}
        {state.draftStale && (
          <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            The published version has changed (now v{state.publishedVersion}) since this draft was started (from v{state.draftBaseVersion}). Check that the draft still says what you want, then save it as <strong>re-based</strong>; only then can it be published.
            <div className="mt-2">
              <Button size="sm" variant="outline" onClick={() => saveDraft(true)} disabled={busy}>
                Save draft re-based onto v{state.publishedVersion}
              </Button>
            </div>
          </div>
        )}
        <div aria-live="polite">
          {msg && (
            <p role={msg.tone === "error" ? "alert" : "status"} data-testid="message" className={cn("rounded-xl border px-4 py-3 text-sm", msg.tone === "ok" ? "border-green-200 bg-green-50 text-green-800" : msg.tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-800")}>
              {msg.text}
              {msg.undo && history.api.canUndo && (
                <button type="button" onClick={() => { history.api.undo(); setMsg(null); }} data-testid="message-undo" className="ml-3 font-semibold underline focus-ring">
                  Undo
                </button>
              )}
            </p>
          )}
          {issues.length > 0 && (
            <ul className="mt-2 space-y-1 rounded-xl border border-red-200 bg-white p-3 text-sm text-red-700" data-testid="issues">
              {issues.map((i, n) => (
                <li key={n} className="flex flex-wrap items-baseline gap-2">
                  {i.path && (
                    <button type="button" onClick={() => select(i.path.replace(/\.(lead|accent)$/, ""), true)} className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-xs text-red-800 hover:bg-red-100 focus-ring">
                      {i.path}
                    </button>
                  )}
                  <span>{i.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Canvas and inspector */}
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_27rem]">
          <div ref={paneRef} className="relative overflow-hidden rounded-xl border border-slate-300 bg-slate-300/50" style={{ height: panelHeight, minHeight: 520 }} data-testid="canvas-pane">
            <div style={{ width: dw * scale, height: pane.h, margin: "0 auto", position: "relative" }}>
              <iframe
                ref={iframe}
                src="/website-preview/editor"
                title="Your homepage. Click any text to edit it."
                data-testid="canvas"
                data-device={device}
                onLoad={() => setReady(false)}
                className="absolute left-0 top-0 border-0 bg-white shadow-lg"
                style={{ width: dw, height: pane.h / scale, transform: `scale(${scale})`, transformOrigin: "top left" }}
              />
            </div>
          </div>
          <aside aria-label="Edit panel" className="overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm" style={{ height: panelHeight, minHeight: 520 }} data-testid="inspector">
            <Inspector
              key={`${selected ?? ""}|${locked ?? ""}`}
              content={content}
              selected={selected}
              locked={locked}
              errors={errors}
              update={update}
              mutate={mutate}
              select={select}
              onMove={onMove}
              onDuplicate={onDuplicate}
              onRemove={(i) => setRemoveIndex(i)}
              onPickImage={(i) => setPicker({ kind: "change", index: i })}
              onPickBlockImage={(section, block, after) => setPicker({ kind: "block", section, block, after })}
              boundary={boundary}
              onAddSection={() => setDialog("add")}
              onPickCardImage={(target) => setPicker({ kind: "card", target })}
              isDefaultOrder={isDefaultOrder}
              onMoveSection={moveTo}
              onResetOrder={onResetOrder}
            />
            {(selected || locked) && (
              <button type="button" onClick={() => select(null)} className="mt-6 text-xs font-semibold text-slate-500 hover:text-slate-800 hover:underline focus-ring">
                Done, show page overview
              </button>
            )}
          </aside>
        </div>
      </div>

      {/* Add section */}
      <Dialog open={dialog === "add"} onClose={() => setDialog(null)} title="Add a section" size="lg">
        <div className="space-y-4">
          <div>
            <label htmlFor="add-slot" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Where should it appear?
            </label>
            <select id="add-slot" value={addSlot} onChange={(e) => setAddSlot(e.target.value as SlotId)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-ring">
              {SLOTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          {content.custom.length >= 12 ? (
            <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              You have reached the limit of 12 added sections. Remove one to add another.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {SECTION_TYPES.map((t) => {
                const Icon = TYPE_ICON[t.type];
                return (
                  <li key={t.type}>
                    <button
                      type="button"
                      data-section-type={t.type}
                      onClick={() => {
                        if (t.type === "image") {
                          setDialog(null);
                          setPicker({ kind: "new", slot: addSlot });
                        } else if (t.type === "video") {
                          setVideoError(null);
                          document.getElementById("add-video-url")?.focus();
                        } else {
                          addSection({ type: t.type }, addSlot);
                          setDialog(null);
                        }
                      }}
                      className="flex h-full w-full items-start gap-3 rounded-xl border border-slate-200 p-3 text-left hover:border-indigo-400 hover:bg-indigo-50/40 focus-ring"
                    >
                      <span className="mt-0.5 rounded-lg bg-indigo-50 p-2 text-indigo-700">
                        <Icon className="h-5 w-5" aria-hidden />
                      </span>
                      <span>
                        <span className="block text-sm font-semibold text-slate-900">{t.label}</span>
                        <span className="block text-xs text-slate-500">{t.hint}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="rounded-xl border border-slate-200 p-3">
            <label htmlFor="add-video-url" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Video: paste a YouTube or Vimeo address
            </label>
            <div className="mt-1 flex gap-2">
              <input id="add-video-url" value={videoUrl} onChange={(e) => { setVideoUrl(e.target.value); setVideoError(null); }} placeholder="https://www.youtube.com/watch?v=…" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus-ring" />
              <Button
                variant="outline"
                disabled={content.custom.length >= 12}
                onClick={() => {
                  const v = parseVideoUrl(videoUrl);
                  if (!v) return setVideoError("That is not a YouTube or Vimeo video address.");
                  addSection({ type: "video", provider: v.provider, videoId: v.videoId }, addSlot);
                  setVideoUrl("");
                  setDialog(null);
                }}
              >
                Add video
              </Button>
            </div>
            {videoError && (
              <p role="alert" className="mt-1 text-xs text-red-700">
                {videoError}
              </p>
            )}
          </div>
        </div>
      </Dialog>

      <MediaPicker open={picker !== null} onClose={() => setPicker(null)} onPick={onPick} />

      {/* Remove section */}
      <ConfirmDialog
        open={removeIndex !== null}
        title="Remove this section?"
        confirmLabel="Remove section"
        danger
        onCancel={() => setRemoveIndex(null)}
        onConfirm={() => {
          if (removeIndex === null) return;
          boundary();
          setContent(removeCustomSection(content, removeIndex));
          setRemoveIndex(null);
          select(null);
          setMsg({ tone: "warn", text: "Section removed from the draft. Undo brings it back until you leave this page; after saving, restore an older version.", undo: true });
        }}
      >
        <p>It is removed from your draft only. The public page does not change until you publish. If you have not saved yet, you can still undo this with “Discard unsaved changes”.</p>
      </ConfirmDialog>

      {/* Publish */}
      <ConfirmDialog open={dialog === "publish"} title={`Publish version ${state.publishedVersion + 1}?`} confirmLabel="Publish now" busy={busy} onCancel={() => setDialog(null)} onConfirm={doPublish}>
        <p>This replaces the wording of the public homepage with your saved draft. A permanent record of this version is kept, and you can restore any earlier version later.</p>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Note (optional)</span>
          <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-ring" />
        </label>
        <p className="text-xs text-slate-500">Visitors may keep seeing the old page for up to about a minute (longer behind a CDN or on several servers).</p>
      </ConfirmDialog>

      {/* Restore */}
      <ConfirmDialog open={restoreVersion !== null} title={`Restore version ${restoreVersion}?`} confirmLabel="Restore and publish" busy={busy} onCancel={() => setRestoreVersion(null)} onConfirm={() => restoreVersion !== null && doRestore(restoreVersion)}>
        <p>Version {restoreVersion} is published again as a new version ({state.publishedVersion + 1}). History is kept, and any unsaved or saved draft is left as it is.</p>
        <label className="block">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Note (optional)</span>
          <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Why you are restoring it" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus-ring" />
        </label>
      </ConfirmDialog>

      {/* Discard */}
      <ConfirmDialog
        open={dialog === "discard"}
        title="Discard unsaved changes?"
        confirmLabel="Discard changes"
        danger
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setContent(JSON.parse(saved));
          setIssues([]);
          setMsg(null);
          setDialog(null);
          select(null);
        }}
      >
        <p>Everything you changed since the last time you saved the draft is lost.</p>
      </ConfirmDialog>

      {/* History */}
      <Dialog open={dialog === "history"} onClose={() => setDialog(null)} title="Revision history" size="lg">
        <p className="text-xs text-slate-500">Every publish and restore, newest first. Entries are permanent; restoring publishes an old version again as a new one.</p>
        {state.revisions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Nothing has been published yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm" data-testid="history">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Version</th>
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Author</th>
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Note</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {state.revisions.map((r) => (
                  <tr key={r.version}>
                    <td className="py-2 pr-3 font-medium text-slate-900">
                      v{r.version} {r.version === state.publishedVersion && pill("ok", "Live")}
                    </td>
                    <td className="py-2 pr-3">{r.kind === "rollback" ? `Restore of v${r.restoredFromVersion}` : "Publish"}</td>
                    <td className="py-2 pr-3">{r.authorName}</td>
                    <td className="whitespace-nowrap py-2 pr-3">{fmt(r.createdAt)}</td>
                    <td className="max-w-[14rem] break-words py-2 pr-3 text-slate-600">{r.note ?? "—"}</td>
                    <td className="py-2 text-right">
                      {r.version !== state.publishedVersion && (
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setDialog(null); setRestoreVersion(r.version); }}>
                          Restore
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Dialog>

      {dirty && (
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={() => setDialog("discard")} className="text-xs font-semibold text-slate-500 hover:text-slate-800 hover:underline focus-ring">
            Discard unsaved changes
          </button>
        </div>
      )}
    </ToolbarProvider>
    </HistoryProvider>
    </ColourMemoryProvider>
  );
}
