"use client";

import { ArrowDown, ArrowUp, ImagePlus, Lock, MousePointerClick, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PlainField, RichField } from "./fields";
import { ButtonForm, HeadingStyleForm, SectionStyleForm, StatCardsForm } from "./panels";
import { SectionManager } from "./SectionManager";
import { BlockPanel, SectionPanel, type SectionPanelProps } from "./SectionPanel";
import { currentOrder, describePath, getCardImage, setCardImage, getIn, insertAt, listBounds, move, outline, parsePath, patchCustom, patchCustomField, patchStatCards, patchStyle, pathKey, removeAt, resetStyle, sectionName, setStatLabel, styleOf, type HeadingRef, type Path } from "@/lib/site-content/editor-model";
import { FIELD_MAX, type EditableContent } from "@/lib/site-content/schema";
import type { RichValue } from "@/lib/site-content/rich";
import { DEFAULT_SITE_CONTENT } from "@/lib/site-content/defaults";
import { BUTTONS, CARD_LABEL, HEADINGS, STAT_LABEL_DEFAULTS, type CardImageTarget, type CardKey, lockReason, sectionInfo, sectionTextColour, textKey, type BuiltinKey, type ButtonKey, type ButtonSettings, type HeadingStyle, type OrderKey, type SectionStyle, type StatCardStyle, type StatLabelKey } from "@/lib/site-content/styles";

// The right-hand panel. What it shows depends on what was clicked on the page: nothing (page overview and the section list), a locked
// element (why it cannot be edited), a text field, a heading made of two parts, a button, a built-in section, a whole added section,
// or one block of a text section. Headings and buttons also show their look settings.

export interface InspectorProps extends Omit<SectionPanelProps, "index"> {
  selected: string | null;
  locked: string | null;
  onAddSection: () => void;
  isDefaultOrder: boolean;
  onMoveSection: (key: OrderKey, finalIndex: number) => void;
  onResetOrder: () => void;
  onPickCardImage: (target: CardImageTarget) => void;
}

function newItem(listPath: Path): unknown {
  const last = listPath[listPath.length - 1];
  const k = pathKey(listPath);
  if (last === "audiences") return "New audience";
  if (last === "fields") return "New field";
  if (last === "bullets") return "New point";
  if (k === "faq.items" || /^custom\.\d+\.items$/.test(k)) return { q: "New question?", a: "Your answer." };
  if (/^custom\.\d+\.cards$/.test(k)) return { title: "New card", text: "Describe this card." };
  return "New item";
}

// The nearest list the clicked element is an item of, if the editor may change that list's length.
function ancestorList(path: Path): { listPath: Path; index: number; bounds: [number, number] } | null {
  for (let i = path.length - 1; i >= 0; i--) {
    if (typeof path[i] === "number") {
      const listPath = path.slice(0, i);
      const bounds = listBounds(listPath);
      if (bounds) return { listPath, index: path[i] as number, bounds };
    }
  }
  return null;
}

const LIST_NOUN: Record<string, string> = { audiences: "audience", fields: "field", bullets: "point", cards: "card", items: "item" };

function ListControls({ content, path, update, select }: { content: EditableContent; path: Path; update: InspectorProps["update"]; select: InspectorProps["select"] }) {
  const a = ancestorList(path);
  if (!a) return null;
  const list = getIn(content, a.listPath) as unknown[];
  const noun = LIST_NOUN[String(a.listPath[a.listPath.length - 1])] ?? "item";
  const tail = path.slice(a.listPath.length + 1);
  const at = (i: number) => pathKey([...a.listPath, i, ...tail]);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3" role="group" aria-label={`This ${noun}`}>
      <p className="text-xs font-semibold text-slate-600">
        This {noun} ({a.index + 1} of {list.length})
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" disabled={a.index === 0} onClick={() => { update(a.listPath, move(list, a.index, a.index - 1)); select(at(a.index - 1)); }} aria-label={`Move ${noun} earlier`}>
          <ArrowUp className="h-3 w-3" aria-hidden /> Earlier
        </Button>
        <Button size="sm" variant="outline" disabled={a.index === list.length - 1} onClick={() => { update(a.listPath, move(list, a.index, a.index + 1)); select(at(a.index + 1)); }} aria-label={`Move ${noun} later`}>
          <ArrowDown className="h-3 w-3" aria-hidden /> Later
        </Button>
        <Button size="sm" variant="outline" disabled={list.length >= a.bounds[1]} onClick={() => { update(a.listPath, insertAt(list, a.index + 1, newItem(a.listPath))); select(at(a.index + 1)); }} aria-label={`Add a ${noun} after this one`}>
          <Plus className="h-3 w-3" aria-hidden /> Add after
        </Button>
        <Button size="sm" variant="danger" disabled={list.length <= a.bounds[0]} onClick={() => { update(a.listPath, removeAt(list, a.index)); select(null); }} aria-label={`Remove this ${noun}`}>
          <Trash2 className="h-3 w-3" aria-hidden /> Remove
        </Button>
      </div>
      <p className="mt-2 text-xs text-slate-400">
        {a.bounds[0]} to {a.bounds[1]} allowed.
      </p>
    </div>
  );
}

// ---- built-in sections and buttons -------------------------------------------------------------------------------------------------

function BuiltinSectionPanel({ p, sectionKey }: { p: InspectorProps; sectionKey: BuiltinKey }) {
  const info = sectionInfo(sectionKey);
  const order = currentOrder(p.content);
  const pos = order.indexOf(sectionKey);
  const reason = lockReason(sectionKey);
  const style = styleOf<SectionStyle>(p.content, "sections", sectionKey);
  const dark = "dark" in info;
  const defaultBg = sectionKey === "register" || sectionKey === "filters" || sectionKey === "structure" || sectionKey === "useCases" || sectionKey === "hero" || sectionKey === "builtFor" ? "#ffffff" : dark ? "#0b2a6f" : sectionKey === "search" ? "#f4f7ff" : "#f8fafc";
  return (
    <div className="space-y-4" data-testid="builtin-section-panel" data-section={sectionKey}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Built-in section</p>
        <h3 className="text-base font-semibold text-slate-900">{info.label}</h3>
        <p className="text-xs text-slate-400">
          Position {pos + 1} of {order.length} on the page
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Section position">
        <Button size="sm" variant="outline" disabled={!!reason || pos <= 1} onClick={() => p.onMoveSection(sectionKey, pos - 1)} aria-label="Move section up" data-testid="section-up">
          <ArrowUp className="h-3.5 w-3.5" aria-hidden /> Up
        </Button>
        <Button size="sm" variant="outline" disabled={!!reason || pos >= order.length - 2} onClick={() => p.onMoveSection(sectionKey, pos + 1)} aria-label="Move section down" data-testid="section-down">
          <ArrowDown className="h-3.5 w-3.5" aria-hidden /> Down
        </Button>
      </div>
      {reason ? (
        <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="section-locked">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden /> {reason}
        </p>
      ) : (
        "note" in info && <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{info.note}</p>
      )}
      <p className="text-xs text-slate-500">Click text inside this section on the page to edit it. Figures and fixed statements stay controlled in code.</p>
      <SectionStyleForm
        idPrefix={`bs-${sectionKey}`}
        style={style}
        patch={(patch) => p.mutate((c) => patchStyle(c, "sections", sectionKey, patch))}
        onReset={() => p.mutate((c) => resetStyle(c, "sections", sectionKey))}
        textColour={sectionTextColour(sectionKey)}
        defaultBg={defaultBg}
      />
    </div>
  );
}

function ButtonPanel({ p, id }: { p: InspectorProps; id: ButtonKey }) {
  const def = BUTTONS[id];
  const labelPath = parsePath(def.labelPath);
  const settings = styleOf<ButtonSettings>(p.content, "buttons", id);
  const row = "row" in def ? def.row : undefined;
  const last = String(labelPath[labelPath.length - 1]);
  const label = String(getIn(p.content, labelPath) ?? "");
  return (
    <div className="space-y-4" data-testid="button-panel" data-button={id}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Button</p>
        <h3 className="text-base font-semibold text-slate-900">{def.label}</h3>
      </div>
      <ButtonForm
        idPrefix={`btn-${id.replace(/\W/g, "-")}`}
        settings={settings}
        label={label}
        defaultHref={def.defaultHref}
        locked={"locked" in def ? def.locked : null}
        look={def.look}
        rowLabel={row === "hero.buttons" ? "hero buttons" : row === "final.buttons" ? "buttons in this row" : undefined}
        rowAlign={row ? styleOf<{ align?: ButtonSettings["align"] }>(p.content, "rows", row).align : undefined}
        onRowAlign={(a) => row && p.mutate((c) => patchStyle(c, "rows", row, { align: a }))}
        labelField={<PlainField id="f-plain" autoFocus label="Button label" value={label} max={FIELD_MAX[last] ?? 40} error={p.errors.get(def.labelPath) ?? null} onChange={(v) => p.update(labelPath, v)} />}
        patch={(patch) => p.mutate((c) => patchStyle(c, "buttons", id, patch))}
        onReset={() =>
          p.mutate((c) =>
            patchStyle(
              c,
              "buttons",
              id,
              Object.fromEntries(Object.keys(styleOf(c, "buttons", id)).filter((k) => k !== "href" && k !== "newTab").map((k) => [k, undefined]))
            )
          )
        }
      />
    </div>
  );
}

function HeadingLook({ p, heading }: { p: InspectorProps; heading: HeadingRef }) {
  if ("builtin" in heading) {
    const def = HEADINGS[heading.builtin];
    return (
      <HeadingStyleForm
        idPrefix="hs"
        style={styleOf<HeadingStyle>(p.content, "headings", heading.builtin)}
        patch={(patch) => p.mutate((c) => patchStyle(c, "headings", heading.builtin, patch))}
        onReset={() => p.mutate((c) => resetStyle(c, "headings", heading.builtin))}
        defaults={{ color: def.color, on: def.on }}
        parts={def.parts}
      />
    );
  }
  const s = p.content.custom[heading.custom];
  if (!s || s.type === "image" || s.type === "video") return null;
  const brand = s.type === "cta" && s.tone === "brand";
  return (
    <HeadingStyleForm
      idPrefix="hs"
      style={(s.headingStyle ?? {}) as HeadingStyle}
      patch={(patch) => p.mutate((c) => patchCustomField(c, heading.custom, "headingStyle", patch))}
      onReset={() => p.mutate((c) => patchCustom(c, heading.custom, { headingStyle: undefined }))}
      defaults={{ color: brand ? "#ffffff" : "#0b2a6f", on: brand ? "#0b2a6f" : "#ffffff" }}
      parts={false}
    />
  );
}

// Look of any other plain-text element (labels, captions, footer and header text, card titles...), stored by the element's path.
function TextLook({ p, path }: { p: InspectorProps; path: string }) {
  const key = textKey(path, p.content.custom);
  const dark = /^(footer|finalCta)\./.test(path);
  return (
    <HeadingStyleForm
      idPrefix="tl"
      title="Text look"
      noun="text"
      style={styleOf<HeadingStyle>(p.content, "texts", key)}
      patch={(patch) => p.mutate((c) => patchStyle(c, "texts", key, patch))}
      onReset={() => p.mutate((c) => resetStyle(c, "texts", key))}
      defaults={{ color: dark ? "#dbeafe" : "#475569", on: dark ? (path.startsWith("footer") ? "#081b4a" : "#0b2a6f") : "#ffffff" }}
      parts={false}
    />
  );
}

// Header and footer links keep the destination they have in the page's design; it is shown here so nothing is hidden.
function LinkNote({ path }: { path: string }) {
  const m = path.match(/^(header|footer)\.links\.(\d+)\.label$/);
  if (!m) return null;
  const href = DEFAULT_SITE_CONTENT[m[1] as "header" | "footer"].links[Number(m[2])]?.href;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="link-destination-note">
      <p className="flex items-center gap-2 font-semibold text-slate-800">
        <Lock className="h-4 w-4 text-slate-500" aria-hidden /> Where this link goes
      </p>
      <p className="mt-1 text-slate-600">
        <code className="rounded bg-white px-1">{href ?? "?"}</code> This link jumps to a section of this page. Its destination is part of the page's navigation and is controlled in code; the label and its look can be edited.
      </p>
    </div>
  );
}

function StatLabelPanel({ p, k }: { p: InspectorProps; k: StatLabelKey }) {
  const def = STAT_LABEL_DEFAULTS[k];
  const value = (p.content.ukRegister.labels as Record<string, string> | undefined)?.[k] ?? def;
  const path = `ukRegister.labels.${k}`;
  return (
    <div className="space-y-4" data-testid="stat-label-panel">
      <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">UK register section</p>
      <PlainField id="f-plain" autoFocus label="Card caption" value={value} max={FIELD_MAX.statLabel} error={p.errors.get(path) ?? null} hint="Only this caption changes. The figure it describes is live data." onChange={(v) => p.mutate((c) => setStatLabel(c, k, v === def ? undefined : v))} />
      <Button size="sm" variant="outline" onClick={() => p.mutate((c) => setStatLabel(c, k, undefined))}>
        Back to the built-in wording
      </Button>
      <TextLook p={p} path={path} />
      {k in { total: 1, active: 1, dissolved: 1, directors: 1, filters: 1, sync: 1 } && (
        <button type="button" onClick={() => p.select(`card:stat.${k}`)} className="text-xs font-semibold text-indigo-700 hover:underline focus-ring">
          Change the look of this card →
        </button>
      )}
    </div>
  );
}

// One card of the UK register section (a figure card, or the large register card): its caption(s) and its own look.
function StatCardPanel({ p, card }: { p: InspectorProps; card: CardKey }) {
  const own = (p.content.styles?.cards?.[card] ?? {}) as StatCardStyle;
  const six = card !== "register";
  const labels = (p.content.ukRegister.labels ?? {}) as Record<string, string>;
  const cap = (k: StatLabelKey, id: string, name: string) => (
    <PlainField key={k} id={id} label={name} value={labels[k] ?? STAT_LABEL_DEFAULTS[k]} max={FIELD_MAX.statLabel} error={p.errors.get(`ukRegister.labels.${k}`) ?? null} onChange={(v) => p.mutate((c) => setStatLabel(c, k, v === STAT_LABEL_DEFAULTS[k] ? undefined : v))} />
  );
  return (
    <div className="space-y-4" data-testid="stat-card-panel" data-card={card}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">UK register section · selected card</p>
        <h3 className="text-base font-semibold text-slate-900" data-testid="stat-card-name">{CARD_LABEL[card]}</h3>
      </div>
      {six ? cap(card as StatLabelKey, "f-plain", "Caption under the figure") : (
        <>
          {cap("cardTitle", "f-plain", "Card title")}
          {cap("cardSub", "card-sub", "Card subtitle")}
          {cap("cardCaption", "card-caption", "Caption under the figure")}
        </>
      )}
      <StatCardsForm
        idPrefix="sc"
        style={own}
        patch={(patch) => p.mutate((c) => patchStyle(c, "cards", card, patch))}
        onReset={() => p.mutate((c) => resetStyle(c, "cards", card))}
        onApplyAll={six ? () => p.mutate((c) => resetStyle(patchStatCards(c, own), "cards", card)) : undefined}
      />
    </div>
  );
}

// A picture slot of the design (a decorative circle, a card header): choose, replace, describe, fit, remove. Shape and size stay the design's.
function CardImagePanel({ p, target }: { p: InspectorProps; target: CardImageTarget }) {
  const ref = getCardImage(p.content, target);
  const name = target.type === "circle" ? `Decorative circle ${target.index + 1}` : `Use-case card ${target.index + 1}: header picture`;
  const round = target.type === "circle";
  const set = (next: typeof ref) => p.mutate((c) => setCardImage(c, target, next));
  return (
    <div className="space-y-4" data-testid="card-image-panel" data-has-image={ref ? "true" : "false"}>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">Picture</p>
        <h3 className="text-base font-semibold text-slate-900">{name}</h3>
      </div>
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{round ? "The picture is cropped to the circle and keeps the design's size and position." : "The picture fills the card's header and keeps the design's size; the tag stays on top."}</p>
      {ref && (
        <div className={round ? "mx-auto h-32 w-32 overflow-hidden rounded-full border border-slate-200 bg-slate-50" : "h-28 overflow-hidden rounded-lg border border-slate-200 bg-slate-50"}>
          {/* eslint-disable-next-line @next/next/no-img-element -- our own /media route */}
          <img src={`/media/${ref.mediaId}`} alt={ref.alt} className={`h-full w-full ${ref.fit === "contain" ? "object-contain" : "object-cover"}`} />
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => p.onPickCardImage(target)} data-testid="choose-card-image">
          <ImagePlus className="h-3.5 w-3.5" aria-hidden /> {ref ? "Replace image" : "Choose image"}
        </Button>
        {ref && (
          <Button size="sm" variant="danger" onClick={() => set(undefined)} data-testid="remove-card-image">
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove (back to the design)
          </Button>
        )}
      </div>
      {ref && (
        <>
          <PlainField id="card-img-alt" label="Image description (alt text)" value={ref.alt} max={FIELD_MAX.alt} error={p.errors.get(round ? `apart.circles.${target.index}.alt` : `useCases.items.${target.index}.image.alt`) ?? null} hint="Describe the image for people who cannot see it" onChange={(v) => set({ ...ref, alt: v })} />
          <div>
            <label htmlFor="card-img-fit" className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              How it fills the {round ? "circle" : "header"}
            </label>
            <select id="card-img-fit" value={ref.fit ?? "cover"} onChange={(e) => set({ ...ref, fit: e.target.value === "contain" ? "contain" : undefined })} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-ring">
              <option value="cover">Fill it (may crop)</option>
              <option value="contain">Show the whole picture</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}

// ---- the panel -------------------------------------------------------------------------------------------------------------------

export function Inspector(p: InspectorProps) {
  const { content, selected, locked } = p;

  if (locked) {
    return (
      <div className="space-y-3" data-testid="locked-panel">
        <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Lock className="h-4 w-4 text-slate-500" aria-hidden /> Controlled in code
        </p>
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{locked}</p>
        <p className="text-xs text-slate-500">Statistics, the API and ownership statements, filter fields, sign-in destinations, icons and the protected FAQ answers cannot be changed from the editor. That keeps the site accurate and consistent.</p>
      </div>
    );
  }

  if (!selected) {
    const order = currentOrder(content);
    return (
      <div className="space-y-4" data-testid="page-panel">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <MousePointerClick className="h-4 w-4 text-indigo-600" aria-hidden /> Click anything on the page
          </p>
          <p className="mt-1 text-sm text-slate-600">Click a heading, paragraph, button or image to edit it here. Changes show on the page straight away and stay a draft until you publish.</p>
        </div>
        <Button onClick={p.onAddSection}>
          <Plus className="h-4 w-4" aria-hidden /> Add section
        </Button>
        <SectionManager
          content={content}
          order={order}
          isDefaultOrder={p.isDefaultOrder}
          selectedKey={null}
          onSelect={(key) => p.select(key.startsWith("custom:") ? `custom.${content.custom.findIndex((s) => `custom:${s.id}` === key)}` : `section:${key}`, true)}
          onMove={p.onMoveSection}
          onReset={p.onResetOrder}
          onRemove={p.onRemove}
        />
        <details className="rounded-lg border border-slate-200" data-testid="outline">
          <summary className="cursor-pointer select-none rounded-lg px-3 py-2 text-sm font-semibold text-slate-800 focus-ring">All page text (list)</summary>
          <div className="space-y-2 border-t border-slate-100 p-2">
            <p className="px-1 text-xs text-slate-500">Every editable text, by section. Use this instead of clicking, or for text that is not on screen (for example the other search tabs).</p>
            {outline(content).map((g) => (
              <details key={g.section} className="rounded-md border border-slate-100">
                <summary className="cursor-pointer select-none px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600 focus-ring">
                  {g.section} <span className="font-normal normal-case text-slate-400">({g.items.length})</span>
                </summary>
                <ul className="space-y-0.5 p-1">
                  {g.items.map((it) => (
                    <li key={it.path}>
                      <button type="button" data-outline-path={it.path} onClick={() => p.select(it.path, true)} className="block w-full rounded px-2 py-1 text-left hover:bg-indigo-50 focus-ring">
                        <span className="block text-xs font-medium text-slate-700">{it.label}</span>
                        <span className="block truncate text-xs text-slate-400">{it.preview}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </details>
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Locked on purpose: statistics, the API and ownership statements, the filter list, sign-in destinations and icons.</p>
      </div>
    );
  }

  const d = describePath(content, selected);
  const path = parsePath(selected);
  const err = (k = selected) => p.errors.get(k) ?? null;
  const back =
    path[0] === "custom" && typeof path[1] === "number" && d.kind !== "section" && d.kind !== "customButton" ? (
      <button type="button" onClick={() => p.select(`custom.${path[1]}`)} className="text-xs font-semibold text-indigo-700 hover:underline focus-ring">
        ← Section options
      </button>
    ) : null;

  if (d.kind === "section") return <SectionPanel {...p} index={d.index} />;
  if (d.kind === "customButton") return <SectionPanel {...p} index={d.section} />;
  if (d.kind === "block") return <BlockPanel content={content} section={d.section} block={d.block} errors={p.errors} update={p.update} mutate={p.mutate} onBack={() => p.select(`custom.${d.section}`)} onPickBlockImage={p.onPickBlockImage} boundary={p.boundary} />;
  if (d.kind === "builtinSection") return <BuiltinSectionPanel p={p} sectionKey={d.key} />;
  if (d.kind === "button") return <ButtonPanel p={p} id={d.button} />;
  if (d.kind === "statLabel") return <StatLabelPanel p={p} k={d.key} />;
  if (d.kind === "statCard") return <StatCardPanel p={p} card={d.card} />;
  if (d.kind === "cardImage") return <CardImagePanel p={p} target={d.target} />;

  if (d.kind === "none") {
    return (
      <p className="text-sm text-slate-500" data-testid="none-panel">
        That element is no longer on the page.
      </p>
    );
  }

  const heading = d.kind === "plain" || d.kind === "headingParts" ? d.heading : undefined;

  return (
    <div className="space-y-4" data-testid="field-panel">
      {back}
      <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600">{sectionName(path)}</p>
      {d.kind === "headingParts" && (
        <>
          <PlainField id="f-lead" label="Heading, first part" autoFocus value={(getIn(content, [...path, "lead"]) as string) ?? ""} max={FIELD_MAX.lead} error={err(`${selected}.lead`)} onChange={(v) => p.update([...path, "lead"], v)} />
          <PlainField id="f-accent" label="Heading, highlighted part" value={(getIn(content, [...path, "accent"]) as string) ?? ""} max={FIELD_MAX.accent} error={err(`${selected}.accent`)} hint="Shown in the brand blue after the first part" onChange={(v) => p.update([...path, "accent"], v)} />
        </>
      )}
      {d.kind === "plain" && (
        <PlainField id="f-plain" autoFocus label={d.label} value={getIn(content, path) as string} max={d.max} multiline={d.multiline} error={err()} hint={d.optional ? "Leave empty to remove" : undefined} onChange={(v) => p.update(path, v)} />
      )}
      {d.kind === "rich" && <RichField id="f-rich" autoFocus label={d.label} value={(getIn(content, path) as RichValue) ?? ""} max={d.max} error={err()} hint={d.optional ? "Leave empty to remove" : undefined} onChange={(v) => p.update(path, v)} />}
      <LinkNote path={selected} />
      {heading ? <HeadingLook p={p} heading={heading} /> : d.kind === "plain" ? <TextLook p={p} path={selected} /> : null}
      <ListControls content={content} path={path} update={p.update} select={p.select} />
    </div>
  );
}
