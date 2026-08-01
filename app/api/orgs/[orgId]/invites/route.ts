import { NextResponse } from "next/server";
import { guard, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { isInviteActive, listInvites } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * Pending/expired invites for the team page. Owner/admin only — invite rows
 * carry join tokens, which is manager-level data.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  const invites = (await listInvites(org.id)).map((invite) => ({
    id: invite.id,
    email: invite.email,
    name: invite.name,
    role: invite.role,
    expiresAt: invite.expiresAt,
    acceptedAt: invite.acceptedAt,
    createdAt: invite.createdAt,
    status: invite.acceptedAt ? "accepted" : isInviteActive(invite) ? "pending" : "expired",
    // Tokens are only exposed for invites that can still be used.
    token: !invite.acceptedAt && isInviteActive(invite) ? invite.token : null,
  }));
  return NextResponse.json({ invites });
});
