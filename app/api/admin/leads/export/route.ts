import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { isAdmin } from "@/lib/admin-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvField(value: string) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { rows } = await getPool().query(
    "SELECT email, url, score, created_at FROM visibility_reports ORDER BY created_at DESC",
  );
  const lines = ["email,website,score,date"];
  for (const row of rows) {
    lines.push([csvField(row.email ?? ""), csvField(row.url ?? ""), String(row.score), new Date(row.created_at).toISOString()].join(","));
  }
  return new NextResponse(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ai-visibility-leads.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
