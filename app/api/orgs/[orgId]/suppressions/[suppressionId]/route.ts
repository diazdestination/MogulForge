import { NextResponse } from "next/server";
import { ApiError, guard, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { removeSuppressionRecord } from "@/lib/suppressions";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; suppressionId: string }> };

/**
 * Removes a suppression record (owner/admin only). Leads already suppressed
 * stay suppressed — this only stops the value from blocking future imports.
 */
export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, suppressionId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const removed = await removeSuppressionRecord(org.id, suppressionId);
  if (!removed) throw new ApiError(404, "Suppression entry not found.");
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "suppression.removed",
    targetType: "suppression",
    targetId: removed.value,
    metadata: { channel: removed.channel, reason: removed.reason },
  });
  return NextResponse.json({ ok: true });
});
