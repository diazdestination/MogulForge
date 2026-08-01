import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getLeadEngagement, insertMessage, listLeadMessages, logActivity } from "@/lib/rescue-engage/store";
import { ASSIGNED_ONLY_ROLES, CONVERSATION_WRITE_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; leadId: string }> };

async function requireLeadAccess(orgId: string, leadId: string, role: string, userId: string) {
  const engagement = await getLeadEngagement(orgId, leadId);
  if (!engagement) throw new ApiError(404, "Lead not found.");
  if (ASSIGNED_ONLY_ROLES.includes(role as (typeof ASSIGNED_ONLY_ROLES)[number]) && engagement.assignedUserId !== userId) {
    throw new ApiError(403, "Sales reps can only view their assigned leads.");
  }
  return engagement;
}

/** Full message thread for a lead. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, leadId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "revenue_rescue");
  await requireLeadAccess(org.id, leadId, role, user.id);
  const messages = await listLeadMessages(org.id, leadId);
  return NextResponse.json({ messages });
});

/**
 * Logs an outbound message the team sent manually (their own phone/email).
 * This is a record of a human action, not a system send — no provider is
 * connected, so the platform itself never sends anything.
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, leadId } = await params;
  const { org, role, user } = await requireMember(orgId, CONVERSATION_WRITE_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const engagement = await requireLeadAccess(org.id, leadId, role, user.id);
  if (engagement.pipelineStage === "suppressed") {
    throw new ApiError(409, "This contact is suppressed — outreach is blocked.");
  }

  const body = (await readJson(request)) as { channel?: string; body?: string; subject?: string };
  const channel = body.channel === "email" ? "email" : body.channel === "call" ? "call" : "sms";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) throw new ApiError(400, "Message text is required.");
  if (text.length > 4000) throw new ApiError(400, "Message text is too long (max 4000 characters).");

  const message = await insertMessage({
    organizationId: org.id,
    leadId,
    direction: "outbound",
    channel,
    subject: typeof body.subject === "string" ? body.subject.slice(0, 150) : null,
    body: text,
    status: "sent", // honest: the human confirms they sent it themselves
    simulated: false,
    provider: "manual",
    createdBy: user.id,
  });
  await logActivity({
    organizationId: org.id,
    leadId,
    activityType: "manual_message_logged",
    title: `Manual ${channel === "call" ? "call" : channel.toUpperCase() + " message"} logged`,
    detail: text.slice(0, 200),
    actorUserId: user.id,
  });
  return NextResponse.json({ message }, { status: 201 });
});
