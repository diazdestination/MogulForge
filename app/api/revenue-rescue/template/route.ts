import { toCsv } from "@/lib/rescue-import/csv";
import { SAMPLE_TEMPLATE_ROWS } from "@/lib/rescue-import/fields";

export const runtime = "nodejs";

/** Downloadable sample CSV template with every supported lead column. */
export async function GET() {
  return new Response(toCsv(SAMPLE_TEMPLATE_ROWS), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="revenue-rescue-lead-template.csv"',
      "Cache-Control": "public, max-age=3600",
    },
  });
}
