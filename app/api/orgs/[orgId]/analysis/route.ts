import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { IMPORT_WRITE_ROLES } from "@/lib/roles";
import { listAnalysisRuns, getActiveRun } from "@/lib/rescue-analysis/store";
import { startAnalysisRun } from "@/lib/rescue-analysis/engine";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Analysis run history + the currently active run (if any). */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "ai_analysis");
  const [runs, activeRun] = await Promise.all([listAnalysisRuns(org.id), getActiveRun(org.id)]);
  return NextResponse.json({ runs, activeRun });
});

/**
 * Starts a batch analysis run over pending/failed leads (optionally scoped to
 * one import via `importId`). One active run per organization at a time.
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, IMPORT_WRITE_ROLES);
  await requireEntitlement(org.id, "ai_analysis");

  const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
  const importId = typeof body.importId === "string" && body.importId.trim() !== "" ? body.importId.trim() : null;

  const result = await startAnalysisRun(org.id, { importId, createdBy: user.id, actorLabel: user.email });
  if (!result.started) {
    if (result.reason === "run_in_progress") {
      throw new ApiError(409, "An analysis run is already in progress for this organization. Wait for it to finish.", "run_in_progress");
    }
    throw new ApiError(400, "No leads are waiting for analysis. Import leads first, or re-run after new imports.", "no_leads");
  }

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "lead_analysis.started",
    targetType: "lead_analysis_run",
    targetId: result.run.id,
    metadata: { importId, totalCount: result.run.totalCount, mode: result.run.mode },
  });
  return NextResponse.json({ run: result.run }, { status: 202 });
});
