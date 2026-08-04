import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { getAnalyticsAccess, refreshAnalyticsSnapshots } from "@/lib/google-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * POST /api/orgs/[orgId]/site-health/analytics — pull fresh Search Console /
 * GA4 snapshots now. Also runs on the external scheduler; this endpoint is the
 * manual "refresh" for managers.
 */
export const POST = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "analytics");

  const access = await getAnalyticsAccess(org.id);
  if (!access.googleConnected) throw new ApiError(409, "Connect your Google account first (Settings → Connections).");
  if (!access.searchConsoleGranted && !access.ga4Granted) {
    throw new ApiError(409, "Your Google connection doesn't include analytics access yet. Use “Grant analytics access” to add it.");
  }
  const { refreshed } = await refreshAnalyticsSnapshots(org.id);
  return NextResponse.json({ refreshed });
});
