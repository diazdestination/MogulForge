import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { IMPORT_WRITE_ROLES } from "@/lib/roles";
import { getLeadImport } from "@/lib/rescue-import/store";
import { startImportPipeline } from "@/lib/rescue-import/pipeline";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; importId: string }> };

/**
 * Safe retry: re-runs the pipeline for a failed/partial/stalled import. The
 * run first clears this import's previous output, so nothing double-inserts.
 */
export const POST = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, importId } = await params;
  const { user, org } = await requireMember(orgId, IMPORT_WRITE_ROLES);
  await requireEntitlement(org.id, "lead_import");

  const record = await getLeadImport(org.id, importId);
  if (!record) throw new ApiError(404, "Import not found.");
  if (record.status === "complete") {
    throw new ApiError(409, "This import already completed. Upload a new file to import more leads.");
  }
  if (!record.fieldMapping) {
    throw new ApiError(400, "Confirm the field mapping before retrying.");
  }

  // The claim inside startImportPipeline is the concurrency gate: an import
  // whose run is still active (fresh lease) cannot be claimed again.
  const started = await startImportPipeline(org.id, importId, user.email);
  if (!started) {
    throw new ApiError(409, "This import is still being processed. Wait for it to finish before retrying.");
  }
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "lead_import.retried",
    targetType: "lead_import",
    targetId: importId,
    metadata: { previousStatus: record.status },
  });
  return NextResponse.json({ ok: true });
});
