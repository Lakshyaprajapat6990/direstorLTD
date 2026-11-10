import { getSession } from "@/lib/auth/session";
import { getMediaBytes, isMediaPublished } from "@/lib/site-content/media-store";
import { MEDIA_ID } from "@/lib/site-content/sections";

// Serves an uploaded website image. Public ONLY while the published content refers to it: a draft, an old revision or a stray
// upload is a 404 for everyone except a signed-in Super Admin (who needs it to edit and preview). The type comes from the file's
// own bytes (JPEG, PNG or WebP only), the response carries nosniff, and the site-wide security headers (next.config.ts) apply.
const NOT_FOUND = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!MEDIA_ID.test(id)) return NOT_FOUND();
  let row: Awaited<ReturnType<typeof getMediaBytes>>;
  try {
    row = await getMediaBytes(id);
  } catch {
    return NOT_FOUND(); // table missing or database unavailable
  }
  if (!row) return NOT_FOUND();

  const session = await getSession();
  const isSuperAdmin = session?.role === "SUPER_ADMIN";
  if (!isSuperAdmin && !(await isMediaPublished(id))) return NOT_FOUND();

  const etag = `"${row.sha256}"`;
  const headers: Record<string, string> = {
    "Content-Type": row.mimeType,
    "Content-Length": String(row.byteSize),
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
    ETag: etag,
    // Content never changes for a given id, so the published copy can be cached for good; a Super Admin's view is private.
    "Cache-Control": isSuperAdmin ? "private, no-store" : "public, max-age=31536000, immutable",
  };
  if (!isSuperAdmin && request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": headers["Cache-Control"] } });
  return new Response(new Uint8Array(row.data), { status: 200, headers });
}
