import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { MESSAGE_WRITE_ROLES } from "@/lib/roles";
import { getLeadDetail, insertMessageDraft, listMessageDrafts } from "@/lib/rescue-analysis/store";
import { generateMessageDraft, SuppressedLeadError } from "@/lib/rescue-analysis/messages";
import { messageRequestSchema } from "@/lib/rescue-analysis/message-content";
import { logAudit } from "@/lib/audit";
import { recordUsageInBackground, requireActionCapacity } from "@/lib/usage";
import { resolveOrgBranding } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; leadId: string }> };

/** Draft history for a lead. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, leadId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "ai_analysis");
  const lead = await getLeadDetail(org.id, leadId);
  if (!lead) throw new ApiError(404, "Lead not found.");
  const drafts = await listMessageDrafts(org.id, leadId);
  return NextResponse.json({ drafts });
});

/**
 * Generates one message draft (sms | email | call_script | voicemail |
 * follow_up_note | sequence) from stored lead facts. Drafts are stored, never
 * sent — sending belongs to the campaigns module. Suppressed and opted-out
 * leads are refused outright.
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, leadId } = await params;
  const { user, org } = await requireMember(orgId, MESSAGE_WRITE_ROLES);
  await requireEntitlement(org.id, "ai_analysis");

  const body = await readJson(request);
  const parsed = messageRequestSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ApiError(400, `Invalid request: ${first?.path.join(".") || "body"} ${first?.message ?? ""}`.trim());
  }

  // Usage gate: message generation is a gated action (suppressed leads are
  // refused by the generator regardless — that refusal is not a usage gate).
  await requireActionCapacity(org.id, { messages_generated: 1 });

  const lead = await getLeadDetail(org.id, leadId);
  if (!lead) throw new ApiError(404, "Lead not found.");

  // White-label branding: drafts are written under the org's sender name.
  const branding = await resolveOrgBranding(org);

  let generated;
  try {
    generated = await generateMessageDraft(lead, parsed.data, parsed.data.type === "sms" ? branding.smsSenderName : branding.emailSenderName);
  } catch (error) {
    if (error instanceof SuppressedLeadError) throw new ApiError(403, error.message, "lead_suppressed");
    throw error;
  }
  recordUsageInBackground(org.id, "messages_generated", 1);

  const draft = await insertMessageDraft({
    organizationId: org.id,
    leadId,
    createdBy: user.id,
    messageType: parsed.data.type,
    tone: parsed.data.tone,
    objective: parsed.data.objective?.trim() || null,
    mode: generated.mode,
    content: generated.content,
    warnings: generated.warnings,
  });

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "lead_message.generated",
    targetType: "lead_message_draft",
    targetId: draft.id,
    metadata: { leadId, messageType: parsed.data.type, tone: parsed.data.tone, mode: generated.mode },
  });
  return NextResponse.json({ draft }, { status: 201 });
});
