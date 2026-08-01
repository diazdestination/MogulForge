import { NextResponse } from "next/server";
import { guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getOverviewMetrics } from "@/lib/rescue-engage/metrics";
import { getProviderStatus } from "@/lib/rescue-engage/providers";
import { ASSIGNED_ONLY_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * Overview dashboard metrics. Sales reps get numbers scoped to their assigned
 * leads — enforced here from the membership role, never from a client flag.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "revenue_rescue");
  const restricted = ASSIGNED_ONLY_ROLES.includes(role);
  const metrics = await getOverviewMetrics(org.id, restricted ? { assignedUserId: user.id } : {});
  return NextResponse.json({
    metrics,
    role,
    scopedToAssigned: restricted,
    providers: { sms: getProviderStatus("sms"), email: getProviderStatus("email") },
  });
});
