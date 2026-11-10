import { createHash } from "node:crypto";

// Deterministic JSON: object keys sorted at every level, no whitespace. The same content always serialises to the same
// string whatever order its keys were built in (and whatever order PostgreSQL's jsonb hands them back), so the SHA-256 of it
// identifies the content. Only JSON values are allowed: anything else (undefined, functions, NaN, cycles) throws.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, new Set()));
}

function sortKeys(v: unknown, seen: Set<unknown>): unknown {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Non-finite number is not valid JSON");
    return v;
  }
  if (typeof v !== "object") throw new Error(`Unsupported value of type ${typeof v}`);
  if (seen.has(v)) throw new Error("Circular structure");
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map((x) => sortKeys(x, seen));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined) throw new Error(`Undefined value at "${k}"`);
      out[k] = sortKeys(x, seen);
    }
    return out;
  } finally {
    seen.delete(v);
  }
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
