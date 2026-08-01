import { NextResponse } from "next/server";
import { guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getReportMetrics, parseReportDate } from "@/lib/rescue-engage/reports";
import { ASSIGNED_ONLY_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * Performance report metrics for a selectable date range. Sales reps get
 * numbers scoped to their assigned leads — enforced from the membership
 * role, never from a client flag.
 */
export const GET = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "analytics");
  const url = new URL(request.url);
  const range = { from: parseReportDate(url.searchParams.get("from")), to: parseReportDate(url.searchParams.get("to")) };
  const restricted = ASSIGNED_ONLY_ROLES.includes(role);
  const metrics = await getReportMetrics(org.id, range, restricted ? { assignedUserId: user.id } : {});
  return NextResponse.json({ metrics, role, scopedToAssigned: restricted });
});
