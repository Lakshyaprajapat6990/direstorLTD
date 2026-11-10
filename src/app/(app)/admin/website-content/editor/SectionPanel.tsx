"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Copy, GripVertical, ImagePlus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { FormatToolbar, type BlockKind } from "./FormatToolbar";
import { PlainField, RichField, RunsField } from "./fields";
import { ButtonForm, HeadingStyleForm, ImageForm, SectionStyleForm } from "./panels";
import { selectCls, labelCls } from "./controls";
import { useSortable } from "./sortable";
import { currentOrder, insertAt, move, newBlock, newButtonBlock, newVideoBlock, patchBlock, patchCustom, patchCustomField, removeAt, setSectionSlot, type Path } from "@/lib/site-content/editor-model";
import { FIELD_MAX, type CustomSectionContent, type EditableContent } from "@/lib/site-content/schema";
import { CTA_TARGETS, SECTION_TYPES, SLOTS, ctaHref, parseVideoUrl, type SlotId } from "@/lib/site-content/sections";
import { customKey, type ButtonSettings, type HeadingStyle, type ImageDisplay, type SectionStyle } from "@/lib/site-content/styles";
import type { BlockProps } from "@/lib/site-content/rich";

// The panel for a whole added section: its place in the page, duplicate and remove, its appearance, and the settings that only exist
// for its type. (Text inside it is edited by clicking it on the page; the same fields are also reachable from here.)

export interface SectionPanelProps {
  content: EditableContent;
  index: number;
  errors: Map<string, string>;
  update: (path: Path, value: unknown) => void;
  mutate: (fn: (c: EditableContent) => EditableContent) => void;
  select: (path: string | null, scroll?: boolean) => void;
  // Moves the section one place earlier/later in the order of the whole page.
  onMove: (index: number, dir: -1 | 1) => void;
  onDuplicate: (index: number) => void;
  onRemove: (index: number) => void;
  onPickImage: (index: number) => void;
  // Opens the image library to add a picture block to a text section, or to replace the picture of one.
  onPickBlockImage: (section: number, block: number | null, after?: number) => void;
  boundary: () => void;
}

const sel = selectCls;
const label = labelCls;

const BLOCK_NAMES: Record<string, string> = { p: "Paragraph", h2: "Heading", h3: "Sub-head", ul: "Bullets", ol: "Numbered", image: "Image", button: "Button", video: "Video" };

export function SectionPanel(p: SectionPanelProps) {
  const s = p.content.custom[p.index] as CustomSectionContent | undefined;
  const [videoUrl, setVideoUrl] = useState("");
  const [videoError, setVideoError] = useState<string | null>(null);
  const blocks = s?.type === "text" ? s.blocks : [];
  const sortable = useSortable(blocks.length, (from, to) => {
    p.boundary();
    p.update(["custom", p.index, "blocks"], move(blocks, from, to));
  });
  if (!s) return null;
  const base: Path = ["custom", p.index];
  const key = `custom.${p.index}`;
  const typeLabel = SECTION_TYPES.find((t) => t.type === s.type)?.label ?? s.type;
  const err = (suffix: string) => p.errors.get(`${key}.${suffix}`) ?? null;
  const order = currentOrder(p.content);
  const pos = order.indexOf(customKey(s.id));

  const setField = (field: string, value: unknown) => p.update([...base, field], value);
  const setOptional = (field: string, value: string) => p.mutate((c) => patchCustom(c, p.index, { [field]: value }));
  const editList = (field: "cards" | "items", fn: (list: unknown[]) => unknown[]) =>
    p.mutate((c) => ({ ...c, custom: c.custom.map((x, i) => (i === p.index ? ({ ...x, [field]: fn((x as unknown as Record<string, unknown[]>)[field]) } as CustomSectionContent) : x)) }));

  const brand = s.type === "cta" && s.tone === "brand";
  const sectionDefaultBg = brand ? "#0b2a6f" : s.type === "cta" ? "#f8fafc" : "#ffffff";
  const textColour = brand ? "#ffffff" : "#0b2a6f";
  const hasHeading = s.type === "text" ? !!s.title : s.type === "cta" || s.type === "faq" || (s.type === "cards" && !!s.heading);

  return (
    <div className="space-y-5" data-testid="section-panel">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Added section</p>
        <h3 className="text-base font-semibold text-slate-900">{typeLabel}</h3>
        <p className="text-xs text-slate-400">
          Position {pos + 1} of {order.length} on the page
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Section actions">
        <Button size="sm" variant="outline" onClick={() => p.onMove(p.index, -1)} disabled={pos <= 1} aria-label="Move section up" data-testid="section-up">
          <ArrowUp className="h-3.5 w-3.5" aria-hidden /> Up
        </Button>
        <Button size="sm" variant="outline" onClick={() => p.onMove(p.index, 1)} disabled={pos >= order.length - 2} aria-label="Move section down" data-testid="section-down">
          <ArrowDown className="h-3.5 w-3.5" aria-hidden /> Down
        </Button>
        <Button size="sm" variant="outline" onClick={() => p.onDuplicate(p.index)} aria-label="Duplicate section">
          <Copy className="h-3.5 w-3.5" aria-hidden /> Duplicate
        </Button>
        <Button size="sm" variant="danger" onClick={() => p.onRemove(p.index)} aria-label="Remove section">
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
        </Button>
      </div>

      <div>
        <label htmlFor="section-slot" className={label}>
          Original placement
        </label>
        <select id="section-slot" className={sel} value={s.slot} onChange={(e) => { p.boundary(); p.mutate((c) => setSectionSlot(c, p.index, e.target.value as SlotId)); }}>
          {SLOTS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-400">Choosing a place moves the section there. You can also drag it in the page-sections list on the overview.</p>
      </div>

      {s.type === "text" && (
        <>
          <PlainField id="sec-title" label="Section heading (optional)" value={s.title ?? ""} max={FIELD_MAX.title} error={err("title")} hint="Leave empty for no heading" onChange={(v) => setOptional("title", v)} />
          <div>
            <p className={label}>Content blocks</p>
            <ol className="mt-1 space-y-1" data-testid="block-list">
              {s.blocks.map((b, j) => (
                <li key={j} className="relative">
                  {sortable.indicatorBefore(j) && <div aria-hidden data-testid="block-drop-indicator" className="absolute -top-px left-0 right-0 z-10 h-0.5 rounded bg-indigo-500" />}
                  <div {...sortable.rowProps(j)} data-block-index={j} className={cn("flex items-center gap-1 rounded-md", sortable.dragging === j && "opacity-40")}>
                    <span className="cursor-grab text-slate-400" aria-hidden title="Drag to move" data-testid="block-handle">
                      <GripVertical className="h-4 w-4" />
                    </span>
                    <button type="button" onClick={() => p.select(`${key}.blocks.${j}`, true)} className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left text-xs text-slate-700 hover:border-indigo-300 focus-ring">
                      <span className="mr-1.5 inline-block w-14 font-semibold text-slate-500">{BLOCK_NAMES[b.kind]}</span>
                      {b.kind === "image" ? b.alt : b.kind === "button" ? `${b.label} → ${b.href}` : b.kind === "video" ? b.title : "runs" in b ? b.runs.map((r) => r.text).join("") : b.items.map((i) => i.map((r) => r.text).join("")).join(" · ")}
                    </button>
                    <button type="button" aria-label={`Move block ${j + 1} up`} disabled={j === 0} onClick={() => { p.boundary(); p.update([...base, "blocks"], move(s.blocks, j, j - 1)); }} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button type="button" aria-label={`Move block ${j + 1} down`} disabled={j === s.blocks.length - 1} onClick={() => { p.boundary(); p.update([...base, "blocks"], move(s.blocks, j, j + 1)); }} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button type="button" aria-label={`Remove block ${j + 1}`} disabled={s.blocks.length <= 1} onClick={() => { p.boundary(); p.update([...base, "blocks"], removeAt(s.blocks, j)); }} className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 focus-ring">
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            {s.blocks.length < 12 && (
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Add a block">
                {([["p", "Paragraph"], ["h2", "Heading"], ["h3", "Sub-heading"], ["ul", "Bullets"], ["ol", "Numbered"]] as const).map(([k, l]) => (
                  <Button key={k} size="sm" variant="outline" onClick={() => { p.boundary(); p.update([...base, "blocks"], insertAt(s.blocks, s.blocks.length, newBlock(k))); p.select(`${key}.blocks.${s.blocks.length}`, true); }}>
                    <Plus className="h-3 w-3" aria-hidden /> {l}
                  </Button>
                ))}
                <Button size="sm" variant="outline" data-testid="add-image-block" onClick={() => p.onPickBlockImage(p.index, null)}>
                  <ImagePlus className="h-3 w-3" aria-hidden /> Image
                </Button>
                <Button size="sm" variant="outline" data-testid="add-button-block" onClick={() => { p.boundary(); p.update([...base, "blocks"], insertAt(s.blocks, s.blocks.length, newButtonBlock())); p.select(`${key}.blocks.${s.blocks.length}`, true); }}>
                  <Plus className="h-3 w-3" aria-hidden /> Button
                </Button>
              </div>
            )}
            {s.blocks.length < 12 && (
              <div className="mt-3">
                <label htmlFor="block-video-url" className={label}>
                  Add a video (YouTube or Vimeo address)
                </label>
                <div className="mt-1 flex gap-2">
                  <input id="block-video-url" data-testid="block-video-url" className={sel} value={videoUrl} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => { setVideoUrl(e.target.value); setVideoError(null); }} />
                  <Button size="sm" variant="outline" data-testid="add-video-block" onClick={() => { const v = parseVideoUrl(videoUrl); if (!v) return setVideoError("That is not a YouTube or Vimeo video address."); p.boundary(); p.update([...base, "blocks"], insertAt(s.blocks, s.blocks.length, newVideoBlock(v))); p.select(`${key}.blocks.${s.blocks.length}`, true); setVideoUrl(""); }}>
                    Add video
                  </Button>
                </div>
                {videoError && <p role="alert" className="mt-1 text-xs text-red-700">{videoError}</p>}
              </div>
            )}
          </div>
        </>
      )}

      {s.type === "image" && (
        <ImageForm
          idPrefix="sec-img"
          mediaId={s.mediaId}
          alt={s.alt}
          caption={s.caption}
          natural={{ width: s.width, height: s.height }}
          display={s as ImageDisplay}
          allowWrap={false}
          errors={{ alt: err("alt"), caption: err("caption") }}
          onField={(f, v) => (f === "alt" ? setField("alt", v) : setOptional("caption", v))}
          patch={(patch) => p.mutate((c) => patchCustom(c, p.index, patch))}
          onReplace={() => p.onPickImage(p.index)}
          sizeChoice={
            <div>
              <label htmlFor="sec-size" className={label}>
                Space it can use
              </label>
              <select id="sec-size" className={sel} value={s.size} onChange={(e) => setField("size", e.target.value)}>
                <option value="medium">Medium (text width)</option>
                <option value="wide">Wide</option>
              </select>
            </div>
          }
        />
      )}

      {s.type === "video" && (
        <>
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            {s.provider === "youtube" ? "YouTube" : "Vimeo"} video <code className="rounded bg-white px-1">{s.videoId}</code>
          </div>
          <div>
            <label htmlFor="sec-video-url" className={label}>
              Change video (paste a YouTube or Vimeo address)
            </label>
            <input id="sec-video-url" className={sel} value={videoUrl} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => { setVideoUrl(e.target.value); setVideoError(null); }} />
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => { const v = parseVideoUrl(videoUrl); if (!v) return setVideoError("That is not a YouTube or Vimeo video address."); p.mutate((c) => ({ ...c, custom: c.custom.map((x, i) => (i === p.index && x.type === "video" ? { ...x, provider: v.provider, videoId: v.videoId } : x)) })); setVideoUrl(""); }}>
                Use this video
              </Button>
              {videoError && (
                <span role="alert" className="text-xs text-red-700">
                  {videoError}
                </span>
              )}
            </div>
          </div>
          <PlainField id="sec-video-title" label="Video title (for screen readers)" value={s.title} max={FIELD_MAX.videoTitle} error={err("title")} onChange={(v) => setField("title", v)} />
          <PlainField id="sec-caption" label="Caption (optional)" value={s.caption ?? ""} max={FIELD_MAX.caption} error={err("caption")} hint="Leave empty for no caption" onChange={(v) => setOptional("caption", v)} />
        </>
      )}

      {s.type === "cta" && (
        <>
          <PlainField id="sec-heading" label="Heading" value={s.heading} max={FIELD_MAX.heading} error={err("heading")} onChange={(v) => setField("heading", v)} />
          <RichField id="sec-text" label="Text (optional)" value={s.text ?? ""} max={FIELD_MAX.text} error={err("text")} hint="Leave empty for no text" onChange={(v) => setField("text", v)} />
          <div>
            <label htmlFor="sec-tone" className={label}>
              Style
            </label>
            <select id="sec-tone" className={sel} value={s.tone} onChange={(e) => setField("tone", e.target.value)}>
              <option value="brand">Dark blue band</option>
              <option value="light">Light band</option>
            </select>
          </div>
          <CtaButton p={p} s={s} />
        </>
      )}

      {s.type === "cards" && (
        <>
          <PlainField id="sec-heading" label="Heading (optional)" value={s.heading ?? ""} max={FIELD_MAX.heading} error={err("heading")} hint="Leave empty for no heading" onChange={(v) => setOptional("heading", v)} />
          <div>
            <p className={label}>Cards ({s.cards.length}/6)</p>
            <ol className="mt-1 space-y-1">
              {s.cards.map((card, j) => (
                <li key={j} className="flex items-center gap-1">
                  <button type="button" onClick={() => p.select(`${key}.cards.${j}.title`, true)} className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left text-xs text-slate-700 hover:border-indigo-300 focus-ring">
                    {card.title}
                  </button>
                  <button type="button" aria-label={`Move card ${j + 1} up`} disabled={j === 0} onClick={() => editList("cards", (l) => move(l, j, j - 1))} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button type="button" aria-label={`Move card ${j + 1} down`} disabled={j === s.cards.length - 1} onClick={() => editList("cards", (l) => move(l, j, j + 1))} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button type="button" aria-label={`Remove card ${j + 1}`} disabled={s.cards.length <= 1} onClick={() => editList("cards", (l) => removeAt(l, j))} className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 focus-ring">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ol>
            {s.cards.length < 6 && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => { editList("cards", (l) => [...l, { title: "New card", text: "Describe this card." }]); p.select(`${key}.cards.${s.cards.length}.title`, true); }}>
                <Plus className="h-3 w-3" aria-hidden /> Add card
              </Button>
            )}
          </div>
        </>
      )}

      {s.type === "faq" && (
        <>
          <PlainField id="sec-heading" label="Heading" value={s.heading} max={FIELD_MAX.heading} error={err("heading")} onChange={(v) => setField("heading", v)} />
          <div>
            <p className={label}>Questions ({s.items.length}/8)</p>
            <ol className="mt-1 space-y-1">
              {s.items.map((item, j) => (
                <li key={j} className="flex items-center gap-1">
                  <button type="button" onClick={() => p.select(`${key}.items.${j}.q`, true)} className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-white px-2 py-1.5 text-left text-xs text-slate-700 hover:border-indigo-300 focus-ring">
                    {item.q}
                  </button>
                  <button type="button" aria-label={`Move question ${j + 1} up`} disabled={j === 0} onClick={() => editList("items", (l) => move(l, j, j - 1))} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button type="button" aria-label={`Move question ${j + 1} down`} disabled={j === s.items.length - 1} onClick={() => editList("items", (l) => move(l, j, j + 1))} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button type="button" aria-label={`Remove question ${j + 1}`} disabled={s.items.length <= 1} onClick={() => editList("items", (l) => removeAt(l, j))} className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 focus-ring">
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ol>
            {s.items.length < 8 && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => { editList("items", (l) => [...l, { q: "New question?", a: "Your answer." }]); p.select(`${key}.items.${s.items.length}.q`, true); }}>
                <Plus className="h-3 w-3" aria-hidden /> Add question
              </Button>
            )}
          </div>
        </>
      )}

      {hasHeading && s.type !== "image" && s.type !== "video" && (
        <HeadingStyleForm
          idPrefix="sec-hs"
          style={(s.headingStyle ?? {}) as HeadingStyle}
          patch={(patch) => p.mutate((c) => patchCustomField(c, p.index, "headingStyle", patch))}
          onReset={() => p.mutate((c) => patchCustom(c, p.index, { headingStyle: undefined }))}
          defaults={{ color: textColour, on: sectionDefaultBg }}
          parts={false}
        />
      )}
      <SectionStyleForm
        idPrefix="sec-style"
        style={(s.style ?? {}) as SectionStyle}
        patch={(patch) => p.mutate((c) => patchCustomField(c, p.index, "style", patch))}
        onReset={() => p.mutate((c) => patchCustom(c, p.index, { style: undefined }))}
        textColour={textColour}
        defaultBg={sectionDefaultBg}
      />
    </div>
  );
}

// The call-to-action button of an added section: label, destination, look.
function CtaButton({ p, s }: { p: SectionPanelProps; s: Extract<CustomSectionContent, { type: "cta" }> }) {
  const settings = (s.button ?? {}) as ButtonSettings;
  const brand = s.tone === "brand";
  const defaultHref = ctaHref(s.target);
  return (
    <ButtonForm
      idPrefix="cta"
      settings={settings}
      label={s.buttonLabel}
      defaultHref={defaultHref}
      locked={null}
      look={brand ? { bg: "#ffffff", color: "#0b2a6f" } : { bg: "#1a56e8", color: "#ffffff" }}
      labelField={<PlainField id="sec-button" label="Button label" value={s.buttonLabel} max={FIELD_MAX.ctaLabel} error={p.errors.get(`custom.${p.index}.buttonLabel`) ?? null} onChange={(v) => p.update(["custom", p.index, "buttonLabel"], v)} />}
      patch={(patch) =>
        p.mutate((c) => {
          // Choosing one of the standard targets keeps using `target`; anything else is stored as the button's own destination.
          if (typeof patch.href === "string") {
            const t = CTA_TARGETS.find((x) => x.href === patch.href);
            if (t) return patchCustomField(patchCustom(c, p.index, { target: t.id }), p.index, "button", { ...patch, href: undefined });
          }
          return patchCustomField(c, p.index, "button", patch);
        })
      }
      onReset={() => p.mutate((c) => patchCustomField(c, p.index, "button", Object.fromEntries(Object.keys(settings).filter((k) => k !== "href" && k !== "newTab").map((k) => [k, undefined]))))}
    />
  );
}

function VideoChange({ onUse }: { onUse: (v: { provider: "youtube" | "vimeo"; videoId: string }) => void }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div>
      <label htmlFor="blk-video-url" className={label}>
        Change video (paste a YouTube or Vimeo address)
      </label>
      <input id="blk-video-url" className={sel} value={url} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => { setUrl(e.target.value); setErr(null); }} />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => { const v = parseVideoUrl(url); if (!v) return setErr("That is not a YouTube or Vimeo video address."); onUse(v); setUrl(""); }}>
          Use this video
        </Button>
        {err && <span role="alert" className="text-xs text-red-700">{err}</span>}
      </div>
    </div>
  );
}

// ---- one block of a text section ------------------------------------------------------------------------------------------------

export function BlockPanel({ content, section, block, errors, update, mutate, onBack, onPickBlockImage, boundary }: { content: EditableContent; section: number; block: number; errors: Map<string, string>; update: (path: Path, value: unknown) => void; mutate: (fn: (c: EditableContent) => EditableContent) => void; onBack: () => void; onPickBlockImage: (section: number, block: number | null, after?: number) => void; boundary: () => void }) {
  const s = content.custom[section];
  if (!s || s.type !== "text") return null;
  const b = s.blocks[block];
  if (!b) return null;
  const path: Path = ["custom", section, "blocks", block];
  const pkey = `custom.${section}.blocks.${block}`;

  const header = (
    <>
      <button type="button" onClick={onBack} className="text-xs font-semibold text-indigo-700 hover:underline focus-ring">
        ← Section options
      </button>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Position of this block">
        <span className="text-xs font-semibold text-slate-600">
          Block {block + 1} of {s.blocks.length}
        </span>
        <Button size="sm" variant="outline" disabled={block === 0} aria-label="Move block up" data-testid="block-up" onClick={() => { boundary(); update(["custom", section, "blocks"], move(s.blocks, block, block - 1)); }}>
          <ArrowUp className="h-3 w-3" aria-hidden /> Up
        </Button>
        <Button size="sm" variant="outline" disabled={block === s.blocks.length - 1} aria-label="Move block down" data-testid="block-down" onClick={() => { boundary(); update(["custom", section, "blocks"], move(s.blocks, block, block + 1)); }}>
          <ArrowDown className="h-3 w-3" aria-hidden /> Down
        </Button>
        {s.blocks.length < 12 && (
          <Button size="sm" variant="outline" data-testid="insert-image-below" onClick={() => onPickBlockImage(section, null, block)}>
            <ImagePlus className="h-3 w-3" aria-hidden /> Insert image below
          </Button>
        )}
      </div>
    </>
  );

  if (b.kind === "image") {
    return (
      <div className="space-y-4" data-testid="block-panel" data-block-kind="image">
        {header}
        <ImageForm
          idPrefix="blk-img"
          mediaId={b.mediaId}
          alt={b.alt}
          caption={b.caption}
          natural={{ width: b.width, height: b.height }}
          display={b as ImageDisplay}
          allowWrap
          errors={{ alt: errors.get(`${pkey}.alt`) ?? null, caption: errors.get(`${pkey}.caption`) ?? null }}
          onField={(f, v) => mutate((c) => patchBlock(c, section, block, { [f]: f === "caption" && v === "" ? undefined : v }))}
          patch={(patch) => mutate((c) => patchBlock(c, section, block, patch))}
          onReplace={() => onPickBlockImage(section, block)}
          onRemove={() => { boundary(); update(["custom", section, "blocks"], removeAt(s.blocks, block)); onBack(); }}
          removeLabel="Remove this image"
        />
      </div>
    );
  }

  if (b.kind === "button") {
    const settings = { ...(b.settings ?? {}), href: b.href };
    return (
      <div className="space-y-4" data-testid="block-panel" data-block-kind="button">
        {header}
        <ButtonForm
          idPrefix="blk-btn"
          settings={settings}
          label={b.label}
          defaultHref="/login"
          locked={null}
          look={{ bg: "#1a56e8", color: "#ffffff" }}
          labelField={<PlainField id="blk-btn-label" label="Button label" value={b.label} max={FIELD_MAX.ctaLabel} error={errors.get(`${pkey}.label`) ?? null} onChange={(v) => mutate((c) => patchBlock(c, section, block, { label: v }))} />}
          patch={(patch) =>
            mutate((c) => {
              const { href, ...rest } = patch as Record<string, unknown>;
              let next = c;
              if ("href" in patch) next = patchBlock(next, section, block, { href: href ?? "/login" });
              if (Object.keys(rest).length) {
                const merged: Record<string, unknown> = { ...(b.settings ?? {}) };
                for (const [k, v] of Object.entries(rest)) {
                  if (v === undefined) delete merged[k];
                  else merged[k] = v;
                }
                next = patchBlock(next, section, block, { settings: Object.keys(merged).length ? merged : undefined });
              }
              return next;
            })
          }
          onReset={() => mutate((c) => patchBlock(c, section, block, { settings: b.settings ? Object.fromEntries(Object.entries(b.settings).filter(([k]) => k === "newTab")) : undefined }))}
        />
        <Button size="sm" variant="danger" onClick={() => { boundary(); update(["custom", section, "blocks"], removeAt(s.blocks, block)); onBack(); }}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove this button
        </Button>
      </div>
    );
  }

  if (b.kind === "video") {
    return (
      <div className="space-y-4" data-testid="block-panel" data-block-kind="video">
        {header}
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {b.provider === "youtube" ? "YouTube" : "Vimeo"} video <code className="rounded bg-white px-1">{b.videoId}</code>. The player is shown on the page at left.
        </div>
        <VideoChange onUse={(v) => mutate((c) => patchBlock(c, section, block, { provider: v.provider, videoId: v.videoId }))} />
        <PlainField id="blk-video-title" label="Video title (for screen readers)" value={b.title} max={FIELD_MAX.videoTitle} error={errors.get(`${pkey}.title`) ?? null} onChange={(v) => mutate((c) => patchBlock(c, section, block, { title: v }))} />
        <PlainField id="blk-video-caption" label="Caption (optional)" value={b.caption ?? ""} max={FIELD_MAX.caption} error={errors.get(`${pkey}.caption`) ?? null} hint="Leave empty for no caption" onChange={(v) => mutate((c) => patchBlock(c, section, block, { caption: v === "" ? undefined : v }))} />
        <Button size="sm" variant="danger" onClick={() => { boundary(); update(["custom", section, "blocks"], removeAt(s.blocks, block)); onBack(); }}>
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove this video
        </Button>
      </div>
    );
  }

  const isList = "items" in b;
  const toKind = (kind: BlockKind) => {
    boundary();
    if (kind === "ul" || kind === "ol") update(path, isList ? { kind, items: b.items } : { kind, items: [b.runs] });
    else update(path, isList ? { kind, runs: b.items.flatMap((r, i) => (i ? [{ text: " " }, ...r] : r)) } : { kind, runs: b.runs, ...(b.align ? { align: b.align } : {}), ...(b.lineHeight !== undefined ? { lineHeight: b.lineHeight } : {}), ...(b.spaceAfter !== undefined ? { spaceAfter: b.spaceAfter } : {}) });
  };

  return (
    <div className="space-y-4" data-testid="block-panel" data-block-kind={b.kind}>
      {header}
      <div>
        <label htmlFor="block-kind" className={label}>
          Style
        </label>
        <select id="block-kind" className={sel} value={b.kind} onChange={(e) => toKind(e.target.value as BlockKind)}>
          <option value="p">Paragraph</option>
          <option value="h2">Heading</option>
          <option value="h3">Sub-heading</option>
          <option value="ul">Bulleted list</option>
          <option value="ol">Numbered list</option>
        </select>
      </div>
      {"runs" in b ? (
        <RunsField
          id="block-text"
          label="Text"
          runs={b.runs}
          max={FIELD_MAX.blockText}
          align={b.align}
          kind={b.kind}
          onKind={toKind}
          onImage={s.blocks.length < 12 ? () => onPickBlockImage(section, null, block) : undefined}
          block={{ lineHeight: b.lineHeight, spaceAfter: b.spaceAfter } as BlockProps}
          onBlock={(patch) => mutate((c) => patchBlock(c, section, block, patch))}
          error={errors.get(`${pkey}.runs`) ?? null}
          onAlign={(a) => mutate((c) => patchBlock(c, section, block, { align: a }))}
          onChange={(runs) => update([...path, "runs"], runs)}
        />
      ) : (
        <div className="space-y-3">
          <FormatToolbar kind={b.kind} onKind={toKind} onImage={s.blocks.length < 12 ? () => onPickBlockImage(section, null, block) : undefined} />
          {b.items.map((runs, k) => (
            <div key={k} className="flex items-start gap-1">
              <div className="min-w-0 flex-1">
                <RunsField id={`block-item-${k}`} label={`Item ${k + 1}`} runs={runs} max={FIELD_MAX.listItem} compact error={errors.get(`${pkey}.items.${k}`) ?? null} onChange={(r) => update([...path, "items", k], r)} />
              </div>
              <div className="mt-6 flex flex-col">
                <button type="button" aria-label={`Move item ${k + 1} up`} disabled={k === 0} onClick={() => update([...path, "items"], move(b.items, k, k - 1))} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button type="button" aria-label={`Move item ${k + 1} down`} disabled={k === b.items.length - 1} onClick={() => update([...path, "items"], move(b.items, k, k + 1))} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 focus-ring">
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button type="button" aria-label={`Remove item ${k + 1}`} disabled={b.items.length <= 1} onClick={() => update([...path, "items"], removeAt(b.items, k))} className="rounded p-1 text-slate-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 focus-ring">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          ))}
          {b.items.length < 12 && (
            <Button size="sm" variant="outline" onClick={() => update([...path, "items"], [...b.items, [{ text: "New item" }]])}>
              <Plus className="h-3 w-3" aria-hidden /> Add item
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
