import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { resolveSyncConflict } from "@/lib/crm/store";
import { MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; conflictId: string }> };

/** Resolves a sync conflict — always an explicit human decision. */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, conflictId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  const resolution = body.resolution;
  if (resolution !== "apply_remote" && resolution !== "keep_local" && resolution !== "dismiss") {
    throw new ApiError(400, "resolution must be apply_remote, keep_local, or dismiss.");
  }
  const conflict = await resolveSyncConflict(org.id, conflictId, resolution, user.id).catch(() => null);
  if (!conflict) throw new ApiError(404, "Conflict not found or already resolved.");
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "crm_conflict.resolved",
    targetType: "crm_sync_conflict",
    targetId: conflictId,
    metadata: { resolution },
  });
  return NextResponse.json({ conflict });
});
