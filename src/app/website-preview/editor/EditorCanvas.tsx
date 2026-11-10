"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HomeView } from "@/components/marketing/HomeView";
import { applyEditable } from "@/lib/site-content/compose";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { asToCanvas, type FromCanvas } from "@/lib/site-content/editor-protocol";
import type { EditableContent } from "@/lib/site-content/schema";
import type { PublicSiteStats } from "@/lib/data/public-stats";
import type { StructureCompany } from "@/lib/data/structure-company";

// The homepage as the editor sees it: the very same HomeView the public route renders, in editing mode (elements carry data-cms
// paths). It lives in an iframe so the browser applies the real responsive breakpoints for the chosen device width. The editor
// page sends content (and the selection) in; this page sends clicks out. Nothing here saves or publishes anything.

type WireStats = Exclude<PublicSiteStats, { state: "ok" }> | (Omit<Extract<PublicSiteStats, { state: "ok" }>, "dataAsOf"> & { dataAsOf: string | null });

function revive(s: WireStats): PublicSiteStats {
  return s.state === "ok" ? { ...s, dataAsOf: s.dataAsOf ? new Date(s.dataAsOf) : null } : s;
}

export function EditorCanvas({ initialContent, stats, structure = null }: { initialContent: EditableContent; stats: WireStats; structure?: StructureCompany | null }) {
  const [content, setContent] = useState<EditableContent>(initialContent);
  const [selected, setSelected] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<string | null>(null);
  const site = useMemo(() => applyEditable(DEFAULT_SITE_CONTENT, content), [content]);
  const revived = useMemo(() => revive(stats), [stats]);

  const send = (m: FromCanvas) => window.parent.postMessage(m, window.location.origin);

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const m = asToCanvas(e.data);
      if (!m) return;
      if (m.type === "cms:content") {
        setContent(m.content as EditableContent);
        send({ type: "cms:ready" });
      } else {
        setSelected(m.path);
        pendingScroll.current = m.scroll && m.path ? m.path : null;
      }
    };
    window.addEventListener("message", on);
    send({ type: "cms:ready" });
    return () => window.removeEventListener("message", on);
  }, []);

  // Outline the selected element (re-applied after every render so it survives content changes).
  useEffect(() => {
    const el0 = root.current;
    if (!el0) return;
    el0.querySelectorAll("[data-cms-selected]").forEach((n) => n.removeAttribute("data-cms-selected"));
    if (selected) el0.querySelector(`[data-cms="${CSS.escape(selected)}"]`)?.setAttribute("data-cms-selected", "");
    if (pendingScroll.current) {
      const target = el0.querySelector(`[data-cms="${CSS.escape(pendingScroll.current)}"]`);
      if (target) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        pendingScroll.current = null;
      }
    }
  });

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // Never leave the editor by clicking a link; tabs and FAQ rows keep working so every tab's text can be reached.
    if (target.closest("a")) e.preventDefault();
    const hit = target.closest("[data-cms],[data-cms-locked]") as HTMLElement | null;
    if (!hit || !root.current?.contains(hit)) {
      setSelected(null);
      send({ type: "cms:select", path: null });
      return;
    }
    const path = hit.getAttribute("data-cms");
    if (path) {
      setSelected(path);
      send({ type: "cms:select", path });
    } else {
      setSelected(null);
      send({ type: "cms:locked", reason: hit.getAttribute("data-cms-locked") ?? "This element is controlled in code." });
    }
  };

  return (
    <div ref={root} className="cms-editing" onClickCapture={onClick} data-testid="canvas-root">
      <HomeView content={site} stats={revived} structure={structure} editing />
    </div>
  );
}
