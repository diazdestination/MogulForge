import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { isReplyCategory } from "@/lib/rescue-engage/replies";
import { processInboundReply } from "@/lib/rescue-engage/reply-service";
import { getLeadEngagement } from "@/lib/rescue-engage/store";
import { ASSIGNED_ONLY_ROLES, CONVERSATION_WRITE_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; leadId: string }> };

/**
 * Records an inbound reply (e.g. a text/call the team received) and runs the
 * rule-based routing: opt-out suppresses immediately, complaints/sensitive
 * stop automation and escalate, interested replies notify the assignee.
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, leadId } = await params;
  const { org, role, user } = await requireMember(orgId, CONVERSATION_WRITE_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const engagement = await getLeadEngagement(org.id, leadId);
  if (!engagement) throw new ApiError(404, "Lead not found.");
  if (ASSIGNED_ONLY_ROLES.includes(role) && engagement.assignedUserId !== user.id) {
    throw new ApiError(403, "Sales reps can only log replies for their assigned leads.");
  }

  const body = (await readJson(request)) as { channel?: string; body?: string; categoryOverride?: string };
  const channel = body.channel === "email" ? "email" : body.channel === "call" ? "call" : "sms";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) throw new ApiError(400, "Reply text is required.");
  if (text.length > 4000) throw new ApiError(400, "Reply text is too long (max 4000 characters).");
  const categoryOverride = typeof body.categoryOverride === "string" && isReplyCategory(body.categoryOverride) ? body.categoryOverride : undefined;

  const outcome = await processInboundReply({
    organizationId: org.id,
    leadId,
    channel,
    body: text,
    actorUserId: user.id,
    categoryOverride,
  });
  return NextResponse.json(outcome, { status: 201 });
});
