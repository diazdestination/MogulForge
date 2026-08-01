import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, listResponse, parsePagination } from "@/lib/public-api/http";
import { listLeadImports } from "@/lib/rescue-import/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/imports — list import batches (metadata only, no file contents). Scope: imports:read. */
export const GET = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "imports:read");
  const url = new URL(request.url);
  const pagination = parsePagination(url);
  const all = await listLeadImports(ctx.org.id, 200);
  const page = all.slice(pagination.offset, pagination.offset + pagination.limit).map((imp) => ({
    id: imp.id,
    fileName: imp.fileName,
    sourceLabel: imp.sourceLabel,
    status: imp.status,
    rowCount: imp.rowCount,
    importedCount: imp.importedCount,
    duplicateCount: imp.duplicateCount,
    suppressedCount: imp.suppressedCount,
    invalidCount: imp.invalidCount,
    error: imp.error,
    createdAt: imp.createdAt,
  }));
  return listResponse(page, pagination, all.length, ctx.rateHeaders);
});
