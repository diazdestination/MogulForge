import { NextResponse } from "next/server";
import { getVisibilityReport, reportHost } from "@/lib/report-lookup";
import { renderVisibilityPdf } from "@/lib/visibility-pdf";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await getVisibilityReport(id);
  if (!row) return NextResponse.json({ error: "Report not found." }, { status: 404 });

  try {
    const pdf = await renderVisibilityPdf({ report: row.report, url: row.url, createdAt: new Date(row.created_at) });
    const host = reportHost(row.url).replace(/[^a-z0-9.-]+/gi, "-") || "report";
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="ai-visibility-${host}.pdf"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error("Failed to render visibility PDF", error);
    return NextResponse.json({ error: "Unable to generate the PDF right now." }, { status: 500 });
  }
}
