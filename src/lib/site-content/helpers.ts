// Small, pure helpers that keep the landing page's layout safe when content has a different shape than today's defaults
// (more or fewer cards, stray spaces). With the built-in content none of them changes what is rendered.

// Words of a heading part, split on any run of whitespace; leading, trailing and repeated spaces never produce empty words.
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

// The item at `index`, wrapping around when there are fewer items than positions (e.g. five cards, three colour treatments).
// An empty list has nothing to pick, so callers pass a non-empty constant list.
export function cycle<T>(items: readonly [T, ...T[]], index: number): T {
  return items[((index % items.length) + items.length) % items.length];
}
