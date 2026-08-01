import { NextResponse } from "next/server";
import { ApiError, guard, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { revokeInvite } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; inviteId: string }> };

/** Revokes a pending invite (owner/admin only). Accepted invites cannot be revoked. */
export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, inviteId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const revoked = await revokeInvite(org.id, inviteId);
  if (!revoked) throw new ApiError(404, "Invite not found, or it was already accepted.");
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "member.invite_revoked",
    targetType: "invite",
    targetId: revoked.email,
    metadata: { role: revoked.role, inviteId: revoked.id },
  });
  return NextResponse.json({ ok: true });
});
