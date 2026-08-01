import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { addSuppressionRecord, listSuppressionRecords } from "@/lib/suppressions";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** The org's suppression list. Any member can view. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role } = await requireMember(orgId);
  return NextResponse.json({
    suppressions: await listSuppressionRecords(org.id),
    canManage: MANAGER_ROLES.includes(role),
  });
});

/**
 * Manually adds a contact to the suppression list (owner/admin only). Existing
 * matching leads are suppressed immediately so the list is never cosmetic.
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const body = await readJson(request);
  const channel = String(body.channel ?? "");
  if (channel !== "email" && channel !== "phone") throw new ApiError(400, "Channel must be email or phone.");
  const value = String(body.value ?? "");
  const result = await addSuppressionRecord(org.id, {
    channel,
    value,
    note: typeof body.note === "string" ? body.note : null,
  });
  if (!result.ok) throw new ApiError(400, result.error);
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "suppression.added",
    targetType: "suppression",
    targetId: result.record.value,
    metadata: { channel, alreadyListed: result.alreadyListed, leadsSuppressed: result.leadsSuppressed },
  });
  return NextResponse.json(
    { record: result.record, alreadyListed: result.alreadyListed, leadsSuppressed: result.leadsSuppressed },
    { status: result.alreadyListed ? 200 : 201 },
  );
});
