import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, PublicApiError } from "@/lib/public-api/http";
import { getLeadImport } from "@/lib/rescue-import/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ importId: string }> };

/** GET /api/v1/imports/:id — import batch detail. Scope: imports:read. */
export const GET = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "imports:read");
  const { importId } = await params;
  const imp = await getLeadImport(ctx.org.id, importId).catch(() => null);
  if (!imp) throw new PublicApiError(404, "not_found", "Import not found.");
  return NextResponse.json(
    {
      data: {
        id: imp.id,
        fileName: imp.fileName,
        sourceLabel: imp.sourceLabel,
        status: imp.status,
        rowCount: imp.rowCount,
        importedCount: imp.importedCount,
        duplicateCount: imp.duplicateCount,
        suppressedCount: imp.suppressedCount,
        invalidCount: imp.invalidCount,
        stageLog: imp.stageLog,
        error: imp.error,
        createdAt: imp.createdAt,
      },
    },
    { headers: ctx.rateHeaders },
  );
});
