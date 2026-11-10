import { NextResponse } from "next/server";
import { requireSuperAdminForCms } from "@/lib/site-content/guard";
import { MAX_IMAGE_BYTES, IMAGE_TYPES } from "@/lib/site-content/image-info";
import { listMedia, saveMedia } from "@/lib/site-content/media-store";
import { readBoundedBytes, requireSameOrigin } from "@/lib/site-content/request";
import { actorOf } from "@/lib/site-content/route-helpers";
import { isMissingTable } from "@/lib/site-content/store";

const notMigrated = () => NextResponse.json({ error: "Images are not set up in this database yet (the migration has not been applied).", code: "not_migrated" }, { status: 503 });

// Super Admin only. The image library for the editor's picker (metadata only, never the bytes).
export async function GET() {
  const auth = await requireSuperAdminForCms();
  if ("error" in auth) return auth.error;
  try {
    return NextResponse.json({ media: await listMedia() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (isMissingTable(err)) return notMigrated();
    throw err;
  }
}

// Super Admin only. Uploads one image as the raw request body (Content-Type image/jpeg, image/png or image/webp, at most 2 MB).
// The type, size and dimensions are decided from the bytes themselves; the same file uploaded twice is stored once.
export async function POST(request: Request) {
  const auth = await requireSuperAdminForCms();
  if ("error" in auth) return auth.error;
  const originProblem = requireSameOrigin(request);
  if (originProblem) return originProblem;
  const declared = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(IMAGE_TYPES as readonly string[]).includes(declared)) return NextResponse.json({ error: "Send the image as image/jpeg, image/png or image/webp.", code: "bad_type" }, { status: 415 });
  const body = await readBoundedBytes(request, MAX_IMAGE_BYTES + 1024);
  if (!body.ok) return body.response;
  try {
    const result = await saveMedia(actorOf(auth.session), { bytes: body.bytes, fileName: request.headers.get("x-file-name") });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
    return NextResponse.json({ ok: true, ...result.value }, { status: result.value.reused ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (isMissingTable(err)) return notMigrated();
    throw err;
  }
}
