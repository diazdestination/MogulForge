import { NextResponse } from "next/server";
import { ApiError, requireMember, readJson } from "@/lib/api-guard";
import { updateOpportunityStatus } from "@/lib/discovery/opportunity-engine";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ orgId: string; id: string }> },
) {
  try {
    const { orgId, id } = await params;
    await requireMember(orgId, MANAGER_ROLES);
    const body = await readJson(request);
    const status = body.status;
    if (status !== "actioned" && status !== "dismissed") {
      throw new ApiError(400, "status must be 'actioned' or 'dismissed'");
    }
    const updated = await updateOpportunityStatus(orgId, id, status);
    if (!updated) throw new ApiError(404, "Opportunity not found.");
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Update opportunity status failed", error);
    return NextResponse.json({ error: "Could not update opportunity." }, { status: 500 });
  }
}
