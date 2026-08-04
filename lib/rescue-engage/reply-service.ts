import "server-only";
import { getPool } from "../db";
import { buildHotLeadAlertEmail, buildReplyAlertEmail } from "../org-alerts-content.ts";
import { sendOrgAlertInBackground } from "../org-alerts.ts";
import { classifyReply, REPLY_CATEGORY_LABELS, REPLY_ROUTING, type ReplyCategory } from "./replies.ts";
import {
  insertMessage,
  latestOutboundCampaignId,
  logActivity,
  markCampaignLeadReplied,
  createTask,
  setLeadStage,
  stopCampaignLeads,
  suppressLeadContact,
  type MessageRecord,
} from "./store.ts";

/**
 * Inbound reply processing: record → classify → route.
 *
 * Routing is rule-based (spec Part 16) and applied unconditionally server-side:
 * - opt-out suppresses the contact immediately, stops ALL automation, and is
 *   never gated by anything else;
 * - complaints and sensitive replies stop automation and escalate to a human;
 * - interested/wants-appointment replies notify the assigned salesperson.
 */

export type ReplyOutcome = {
  message: MessageRecord;
  category: ReplyCategory;
  confidence: number;
  matched: string | null;
  actions: string[];
};

export async function processInboundReply(input: {
  organizationId: string;
  leadId: string;
  channel: "sms" | "email" | "call";
  body: string;
  actorUserId: string | null;
  /** Explicit override when a human corrects the classification while logging a call. */
  categoryOverride?: ReplyCategory;
  /** Message source: 'manual' for human-logged replies, or the webhook provider ('twilio' / 'resend_outreach'). */
  provider?: string;
}): Promise<ReplyOutcome> {
  const classification = input.categoryOverride
    ? { category: input.categoryOverride, confidence: 1, matched: "manual" }
    : classifyReply(input.body);
  const campaignId = await latestOutboundCampaignId(input.organizationId, input.leadId);
  const routing = REPLY_ROUTING[classification.category];
  const actions: string[] = [];

  const message = await insertMessage({
    organizationId: input.organizationId,
    leadId: input.leadId,
    campaignId,
    direction: "inbound",
    channel: input.channel,
    body: input.body,
    status: "received",
    simulated: false,
    provider: input.provider ?? "manual",
    createdBy: input.actorUserId,
    replyCategory: classification.category,
    replyConfidence: classification.confidence,
    replyRule: classification.matched,
  });

  // Lead context for assignment-aware routing.
  const { rows } = await getPool().query(
    "SELECT first_name, last_name, assigned_user_id, pipeline_stage FROM rescue_leads WHERE organization_id = $1 AND id = $2",
    [input.organizationId, input.leadId],
  );
  const lead = rows[0] ?? {};
  const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Unnamed lead";

  // 1. Opt-out: immediate, unconditional suppression before anything else.
  if (routing.suppress) {
    await suppressLeadContact(input.organizationId, input.leadId, "Opt-out reply received", { optOut: true });
    actions.push("Contact suppressed immediately — all future automated outreach is blocked.");
    await logActivity({
      organizationId: input.organizationId,
      leadId: input.leadId,
      campaignId,
      activityType: "contact_suppressed",
      title: `${leadName} opted out — contact suppressed`,
      metadata: { category: classification.category },
      actorUserId: input.actorUserId,
    });
  }

  // 2. Stop automation (campaign-level or everywhere).
  if (!routing.suppress && routing.stopAutomation !== "none") {
    const stopped = await stopCampaignLeads(
      input.organizationId,
      input.leadId,
      classification.category,
      routing.stopAutomation === "campaign" ? campaignId : null,
    );
    if (stopped > 0) actions.push(routing.stopAutomation === "all" ? "All campaign automation stopped for this lead." : "This campaign's automation stopped for this lead.");
  }

  // 3. Mark the campaign membership as replied (kept even when stopped — reply stats stay honest).
  if (campaignId) await markCampaignLeadReplied(input.organizationId, input.leadId, campaignId);

  // 4. Pipeline stage movement.
  if (routing.setStage) {
    const moved = await setLeadStage(input.organizationId, input.leadId, routing.setStage);
    if (moved) actions.push(`Lead moved to "${routing.setStage}".`);
  }

  // 5. Notify assignee / escalate via follow-up tasks (in-app — no client notification provider is connected).
  if (routing.task) {
    const dueAt = routing.task.dueInDays != null ? new Date(Date.now() + routing.task.dueInDays * 86400000).toISOString() : null;
    const assignee = routing.notifyAssignee ? (lead.assigned_user_id ?? null) : routing.escalate ? null : (lead.assigned_user_id ?? null);
    await createTask({
      organizationId: input.organizationId,
      leadId: input.leadId,
      campaignId,
      assignedUserId: assignee,
      title: routing.task.title,
      detail: `Reply (${REPLY_CATEGORY_LABELS[classification.category]}): "${input.body.slice(0, 300)}"`,
      dueAt,
      source: routing.task.source,
      createdBy: input.actorUserId,
    });
    actions.push(
      routing.escalate
        ? "Escalated: review task created for managers."
        : routing.notifyAssignee
          ? lead.assigned_user_id
            ? "Assigned salesperson notified with a follow-up task."
            : "Follow-up task created (lead is unassigned — visible to managers)."
          : "Follow-up task created.",
    );
  }

  await logActivity({
    organizationId: input.organizationId,
    leadId: input.leadId,
    campaignId,
    activityType: routing.escalate ? "reply_escalated" : classification.category === "interested" || classification.category === "wants_appointment" ? "positive_reply" : "reply_received",
    title: `${leadName} replied — ${REPLY_CATEGORY_LABELS[classification.category]}`,
    detail: input.body.slice(0, 200),
    metadata: { category: classification.category, confidence: classification.confidence },
    actorUserId: input.actorUserId,
  });

  // 6. Email the org's saved notification addresses (Settings → Notifications).
  // Hot replies use the hot-lead toggle; other replies use the reply toggle.
  // Fire-and-forget: an alert failure never fails reply processing.
  const isHotReply = classification.category === "interested" || classification.category === "wants_appointment";
  const orgRows = await getPool().query("SELECT name FROM organizations WHERE id = $1", [input.organizationId]);
  const orgName: string = orgRows.rows[0]?.name ?? "Your organization";
  const alertInput = {
    orgName,
    leadName,
    replyBody: input.body,
    channel: input.channel,
    categoryLabel: REPLY_CATEGORY_LABELS[classification.category],
  };
  if (isHotReply) {
    sendOrgAlertInBackground(input.organizationId, "hotLeadAlerts", buildHotLeadAlertEmail(alertInput));
  } else {
    sendOrgAlertInBackground(input.organizationId, "replyAlerts", buildReplyAlertEmail(alertInput));
  }

  return {
    message,
    category: classification.category,
    confidence: classification.confidence,
    matched: classification.matched,
    actions,
  };
}
