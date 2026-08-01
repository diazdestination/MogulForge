import { NextResponse } from "next/server";
import { guard, readJson, requireMember, ApiError } from "@/lib/api-guard";
import { MANAGER_ROLES, isOrgRole } from "@/lib/roles";
import { getMemberByMembershipId, removeMember, updateMemberRole } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; membershipId: string }> };

export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, membershipId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const body = await readJson(request);
  const role = String(body.role ?? "");
  if (!isOrgRole(role)) throw new ApiError(400, "Invalid role.");
  const target = await getMemberByMembershipId(org.id, membershipId);
  if (!target) throw new ApiError(404, "Member not found in this organization.");
  if (target.role === "owner") throw new ApiError(400, "The owner's role cannot be changed here.");
  const changed = await updateMemberRole(org.id, membershipId, role);
  if (!changed) throw new ApiError(404, "Member not found in this organization.");
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "member.role_changed",
    targetType: "membership",
    targetId: membershipId,
    metadata: { email: target.email, from: target.role, to: role },
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, membershipId } = await params;
  const { user, org, membershipId: selfMembershipId } = await requireMember(orgId, MANAGER_ROLES);
  const target = await getMemberByMembershipId(org.id, membershipId);
  if (!target) throw new ApiError(404, "Member not found in this organization.");
  if (target.role === "owner") throw new ApiError(400, "The owner cannot be removed.");
  if (membershipId === selfMembershipId) throw new ApiError(400, "You cannot remove yourself.");
  await removeMember(org.id, membershipId);
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "member.removed",
    targetType: "membership",
    targetId: membershipId,
    metadata: { email: target.email, role: target.role },
  });
  return NextResponse.json({ ok: true });
});
