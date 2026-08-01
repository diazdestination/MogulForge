import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getAnalysisRun } from "@/lib/rescue-analysis/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; runId: string }> };

/** Analysis run progress — the dashboard polls this while a run is active. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, runId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "ai_analysis");
  const run = await getAnalysisRun(org.id, runId);
  if (!run) throw new ApiError(404, "Analysis run not found.");
  return NextResponse.json({ run });
});
