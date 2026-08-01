import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { toCsv } from "@/lib/rescue-import/csv";
import { getLeadImport, listRejectedRows } from "@/lib/rescue-import/store";
import { rejectedExportHeaders } from "@/lib/rescue-import/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; importId: string }> };

/**
 * Rejected-rows CSV export. Every cell goes through formula-injection-safe
 * escaping — values starting with = + - @ are prefixed so spreadsheets treat
 * them as text.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, importId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "lead_import");
  const record = await getLeadImport(org.id, importId);
  if (!record) throw new ApiError(404, "Import not found.");
  const rejected = await listRejectedRows(org.id, importId);
  const headers = rejectedExportHeaders(record.columns);
  const rows: unknown[][] = [
    headers,
    ...rejected.map((row) => [row.rowNumber, row.reason, ...record.columns.map((column) => row.rowData[column] ?? "")]),
  ];
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rejected-rows-${importId.slice(0, 8)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
