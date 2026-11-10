// What the editor may ADD to the homepage: a fixed menu of section types, placed in fixed slots between the built-in sections.
// Built-in sections never move, disappear or change structure (they carry the statistics and the protected statements);
// custom sections are inserted around them. Pure data and helpers, shared by validation, rendering and the editor.

export const SLOTS = [
  { id: "afterHero", label: "After the hero" },
  { id: "afterRegister", label: "After the UK register and official source" },
  { id: "afterSearch", label: "After the search section" },
  { id: "afterWorkflow", label: "After the reports and CRM section" },
  { id: "afterPlatform", label: "After the platform cards" },
  { id: "beforeFaq", label: "Before the FAQ" },
  { id: "afterFaq", label: "After the FAQ (before the final call to action)" },
] as const;
export type SlotId = (typeof SLOTS)[number]["id"];
export const SLOT_IDS = SLOTS.map((s) => s.id) as [SlotId, ...SlotId[]];

// Where a custom call-to-action button may lead: the site's own sign-in page and public anchors. Not free-form.
export const CTA_TARGETS = [
  { id: "login", href: "/login", label: "Sign in page" },
  { id: "explore", href: "#uk-data", label: "UK data section" },
  { id: "search", href: "#search", label: "Search section" },
  { id: "filters", href: "#filters", label: "Filters section" },
  { id: "workflow", href: "#workflow", label: "Reports & CRM section" },
  { id: "faq", href: "#faq", label: "FAQ section" },
] as const;
export type CtaTargetId = (typeof CTA_TARGETS)[number]["id"];
export const CTA_TARGET_IDS = CTA_TARGETS.map((t) => t.id) as [CtaTargetId, ...CtaTargetId[]];
export const ctaHref = (id: CtaTargetId) => CTA_TARGETS.find((t) => t.id === id)?.href ?? "/login";

export const MAX_CUSTOM_SECTIONS = 12;

export const SECTION_TYPES = [
  { type: "text", label: "Heading and text", hint: "A heading with paragraphs, sub-headings and lists." },
  { type: "image", label: "Image with caption", hint: "One uploaded image, with alt text and an optional caption." },
  { type: "video", label: "Video", hint: "A YouTube or Vimeo video." },
  { type: "cta", label: "Call to action", hint: "A heading, a sentence and one button." },
  { type: "cards", label: "Feature cards", hint: "Up to six short cards in a grid." },
  { type: "faq", label: "FAQ", hint: "Questions and answers that open and close." },
] as const;
export type SectionType = (typeof SECTION_TYPES)[number]["type"];

// ---- video -------------------------------------------------------------------------------------------------------------------

export const VIDEO_PROVIDERS = ["youtube", "vimeo"] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];
export const VIDEO_ID: Record<VideoProvider, RegExp> = { youtube: /^[A-Za-z0-9_-]{11}$/, vimeo: /^\d{6,12}$/ };

// Pulls a provider and id out of a pasted address. Only these providers and these address shapes are understood.
export function parseVideoUrl(input: string): { provider: VideoProvider; videoId: string } | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  let id: string | null = null;
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/);
      id = m ? m[1] : null;
    }
    return id && VIDEO_ID.youtube.test(id) ? { provider: "youtube", videoId: id } : null;
  }
  if (host === "youtu.be") {
    id = u.pathname.slice(1).split("/")[0];
    return VIDEO_ID.youtube.test(id) ? { provider: "youtube", videoId: id } : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = u.pathname.match(/^\/(?:video\/)?(\d{6,12})(?:\/|$)/);
    return m && VIDEO_ID.vimeo.test(m[1]) ? { provider: "vimeo", videoId: m[1] } : null;
  }
  return null;
}

export function embedUrl(provider: VideoProvider, videoId: string): string {
  return provider === "youtube" ? `https://www.youtube-nocookie.com/embed/${videoId}` : `https://player.vimeo.com/video/${videoId}`;
}

export const MEDIA_ID = /^[a-f0-9]{32}$/;
export const mediaSrc = (id: string) => `/media/${id}`;
