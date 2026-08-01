import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getLeadImport } from "@/lib/rescue-import/store";
import { latestRunForImport } from "@/lib/rescue-analysis/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; importId: string }> };

/**
 * Import detail + stage log — the dashboard polls this while a pipeline runs.
 * Includes the latest analysis run for the import (the post-import "analyzing"
 * phase), so the UI can show scoring progress after the import completes.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, importId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "lead_import");
  const record = await getLeadImport(org.id, importId);
  if (!record) throw new ApiError(404, "Import not found.");
  const analysisRun = await latestRunForImport(org.id, importId);
  return NextResponse.json({ import: record, analysisRun });
});
