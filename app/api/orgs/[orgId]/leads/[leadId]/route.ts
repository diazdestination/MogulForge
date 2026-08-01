import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getLeadDetail, listMessageDrafts } from "@/lib/rescue-analysis/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; leadId: string }> };

/**
 * Full lead detail: contact/project facts, score, category, the complete
 * analysis explanation (deterministic signals + AI rationale), and every
 * generated message draft.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, leadId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "lead_import");
  const lead = await getLeadDetail(org.id, leadId);
  if (!lead) throw new ApiError(404, "Lead not found.");
  const drafts = await listMessageDrafts(org.id, leadId);
  return NextResponse.json({ lead, drafts });
});
