import { getSession } from "@/lib/auth/session";
import { hasRole } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { digestFileName } from "@/lib/digest/dailyDigest";

export const dynamic = "force-dynamic";

const TYPES = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
} as const;

// Super Admin only: download one stored daily digest file (Excel workbook or PDF summary).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; format: string }> }) {
  const session = await getSession();
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasRole(session, "SUPER_ADMIN")) return Response.json({ error: "Forbidden" }, { status: 403 });

  const { id, format } = await params;
  if (format !== "xlsx" && format !== "pdf") return Response.json({ error: "Not found" }, { status: 404 });
  // Select only the requested file: the other one may be several MB.
  const where = { id: id.slice(0, 60) };
  const row =
    format === "xlsx"
      ? await db.dailyDigest.findUnique({ where, select: { day: true, xlsx: true } }).then((r) => r && { day: r.day, data: r.xlsx })
      : await db.dailyDigest.findUnique({ where, select: { day: true, pdf: true } }).then((r) => r && { day: r.day, data: r.pdf });
  if (!row) return Response.json({ error: "Not found" }, { status: 404 });
  const data = row.data;

  await db.activityLog.create({ data: { userId: session.userId, action: "daily_digest_download", meta: JSON.stringify({ day: row.day.toISOString().slice(0, 10), format }) } });
  return new Response(Buffer.from(data), {
    headers: {
      "Content-Type": TYPES[format],
      "Content-Disposition": `attachment; filename="${digestFileName(row.day, format)}"`,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
