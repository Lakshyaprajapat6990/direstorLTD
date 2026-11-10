import { NextResponse } from "next/server";

// Request hygiene for the CMS mutation routes. Nothing here authorises anything: authorisation is guard.ts, called first.

export const MAX_BODY_BYTES = 128 * 1024;

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

// Browsers send an Origin header on every cross-site and same-site POST/PUT; a request without one, or from another host,
// is refused. X-Forwarded-Host is trusted only when TRUST_PROXY=1 (the same switch the login throttle uses).
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  const host = request.headers.get("host");
  if (host) allowed.add(host.toLowerCase());
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
    if (forwarded) allowed.add(forwarded);
  }
  return allowed.has(originHost);
}

export function isJsonContentType(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/json";
}

// Reads at most `maxBytes` of the body before anything is parsed: an oversized body is cut off, never buffered whole.
export async function readBoundedBytes(request: Request, maxBytes: number): Promise<{ ok: true; bytes: Buffer } | { ok: false; response: NextResponse }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: fail(413, "Request body is too large.") };
  if (!request.body) return { ok: true, bytes: Buffer.alloc(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, response: fail(413, "Request body is too large.") };
    }
    chunks.push(value);
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

export async function readBoundedText(request: Request, maxBytes = MAX_BODY_BYTES): Promise<{ ok: true; text: string } | { ok: false; response: NextResponse }> {
  const r = await readBoundedBytes(request, maxBytes);
  if (!r.ok) return r;
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(r.bytes) };
}

// Origin check, strict JSON content type, bounded read, then JSON.parse.
export async function readMutationJson(request: Request): Promise<{ ok: true; json: unknown } | { ok: false; response: NextResponse }> {
  if (!isSameOrigin(request)) return { ok: false, response: fail(403, "Cross-origin or origin-less request refused.") };
  if (!isJsonContentType(request)) return { ok: false, response: fail(415, "Content-Type must be application/json.") };
  const body = await readBoundedText(request);
  if (!body.ok) return body;
  try {
    return { ok: true, json: JSON.parse(body.text) };
  } catch {
    return { ok: false, response: fail(400, "Body is not valid JSON.") };
  }
}

// Origin check only, for mutations that carry no body.
export function requireSameOrigin(request: Request): NextResponse | null {
  return isSameOrigin(request) ? null : fail(403, "Cross-origin or origin-less request refused.");
}
