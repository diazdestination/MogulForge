import { NextResponse } from "next/server";
import { guard, readJson, requireMember, ApiError } from "@/lib/api-guard";
import { MANAGER_ROLES, isOrgRole } from "@/lib/roles";
import { createInvite, listMembers } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId);
  return NextResponse.json({ members: await listMembers(org.id) });
});

/** Invite a new member (owner/admin only). Creates an invite the recipient accepts at /invite/[token]. */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const body = await readJson(request);
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Enter a valid email address.");
  if (!isOrgRole(role)) throw new ApiError(400, "Invalid role.");
  if (role === "owner") throw new ApiError(400, "Ownership transfers are not supported via invites.");
  const invite = await createInvite(org.id, { email, name: typeof body.name === "string" ? body.name : null, role });
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "member.invited",
    targetType: "invite",
    targetId: email,
    metadata: { role },
  });
  return NextResponse.json({ invite: { id: invite.id, email: invite.email, role: invite.role, token: invite.token, expiresAt: invite.expiresAt } }, { status: 201 });
});
