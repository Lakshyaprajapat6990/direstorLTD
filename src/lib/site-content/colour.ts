// Colour helpers shared by validation (server) and the colour picker (browser). A stored colour is ALWAYS a six-digit hex string,
// lower-cased: nothing else (no names, rgb(), var(), url(), gradients) can reach a style attribute.

export const HEX = /^#[0-9a-f]{6}$/;

export const isHex = (v: unknown): v is string => typeof v === "string" && HEX.test(v);

// Accepts what a person might type: "2457E8", "#2457e8", "#abc", " #ABC ". Returns the canonical "#rrggbb" or null.
export function parseHex(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (s.startsWith("#")) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/.test(s) ? `#${s}` : null;
}

export type Rgb = [number, number, number];
export type Hsv = { h: number; s: number; v: number }; // h 0-360, s/v 0-1

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsv([r, g, b]: Rgb): Hsv {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export const hexToHsv = (hex: string) => rgbToHsv(hexToRgb(hex));
export const hsvToHex = (hsv: Hsv) => rgbToHex(hsvToRgb(hsv));

// WCAG 2 relative luminance and contrast ratio (1 to 21).
export function luminance(hex: string): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// "ok" meets WCAG AA for normal text (4.5), "large" only for large text (3), otherwise "low".
export function contrastLevel(ratio: number): "ok" | "large" | "low" {
  return ratio >= 4.5 ? "ok" : ratio >= 3 ? "large" : "low";
}

// The site's own colours, offered as one-click choices next to the free picker.
export const BRAND_SWATCHES: { hex: string; label: string }[] = [
  { hex: "#1a56e8", label: "Brand blue" },
  { hex: "#0b2a6f", label: "Navy" },
  { hex: "#081b4a", label: "Deep navy" },
  { hex: "#5a8bff", label: "Light blue" },
  { hex: "#ffffff", label: "White" },
  { hex: "#f1f5f9", label: "Pale grey" },
  { hex: "#64748b", label: "Slate" },
  { hex: "#0f172a", label: "Near black" },
  { hex: "#15803d", label: "Green" },
  { hex: "#b45309", label: "Amber" },
  { hex: "#b91c1c", label: "Red" },
];
