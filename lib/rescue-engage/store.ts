import "server-only";
import { getPool } from "../db";
import type { AppointmentProvider, AppointmentStatus, AppointmentType } from "./calendar-adapters.ts";
import type { ApprovalMode, AudienceFilters, CampaignChannel, CampaignInput, CampaignSchedule, CampaignStatus, StopCondition } from "./campaign-schema.ts";
import type { PipelineStage } from "./pipeline.ts";
import type { ReplyCategory } from "./replies.ts";

/**
 * Tenant data layer for campaigns, messages/conversations, appointments,
 * activities, and follow-up tasks. Every query is scoped by organization_id.
 */

// ---- Campaigns -------------------------------------------------------------------

export type Campaign = {
  id: string;
  createdBy: string | null;
  name: string;
  templateKey: string | null;
  objective: string | null;
  channel: CampaignChannel;
  tone: string;
  senderIdentity: string | null;
  audience: AudienceFilters;
  schedule: CampaignSchedule;
  approvalMode: ApprovalMode;
  followUpDelayDays: number;
  maxAttempts: number;
  stopConditions: StopCondition[];
  bookingLink: string | null;
  assignedUserId: string | null;
  mode: "simulation" | "live";
  status: CampaignStatus;
  activatedAt: string | null;
  activatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CampaignStats = {
  enrolled: number;
  messaged: number;
  simulatedSends: number;
  liveSends: number;
  delivered: number;
  replies: number;
  optOuts: number;
  appointments: number;
  pipelineValue: number;
  linkClicks: number;
};

const CAMPAIGN_COLUMNS = `id, created_by, name, template_key, objective, channel, tone, sender_identity,
  audience, schedule, approval_mode, follow_up_delay_days, max_attempts, stop_conditions, booking_link,
  assigned_user_id, mode, status, activated_at, activated_by, created_at, updated_at`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapCampaign(row: any): Campaign {
  return {
    id: row.id,
    createdBy: row.created_by,
    name: row.name,
    templateKey: row.template_key,
    objective: row.objective,
    channel: row.channel,
    tone: row.tone,
    senderIdentity: row.sender_identity,
    audience: {
      categories: row.audience?.categories ?? [],
      minScore: row.audience?.minScore ?? null,
      projectTypes: row.audience?.projectTypes ?? [],
      sources: row.audience?.sources ?? [],
      importId: row.audience?.importId ?? null,
    },
    schedule: {
      startDate: row.schedule?.startDate ?? null,
      quietHoursStart: row.schedule?.quietHoursStart ?? 20,
      quietHoursEnd: row.schedule?.quietHoursEnd ?? 8,
    },
    approvalMode: row.approval_mode,
    followUpDelayDays: row.follow_up_delay_days,
    maxAttempts: row.max_attempts,
    stopConditions: row.stop_conditions ?? [],
    bookingLink: row.booking_link,
    assignedUserId: row.assigned_user_id,
    mode: row.mode,
    status: row.status,
    activatedAt: row.activated_at,
    activatedBy: row.activated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createCampaign(organizationId: string, createdBy: string | null, input: CampaignInput): Promise<Campaign> {
  const { rows } = await getPool().query(
    `INSERT INTO rescue_campaigns (organization_id, created_by, name, template_key, objective, channel, tone,
       sender_identity, audience, schedule, approval_mode, follow_up_delay_days, max_attempts, stop_conditions,
       booking_link, assigned_user_id, mode, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14::jsonb, $15, $16, 'simulation', 'draft')
     RETURNING ${CAMPAIGN_COLUMNS}`,
    [
      organizationId, createdBy, input.name, input.templateKey, input.objective, input.channel, input.tone,
      input.senderIdentity, JSON.stringify(input.audience), JSON.stringify(input.schedule), input.approvalMode,
      input.followUpDelayDays, input.maxAttempts, JSON.stringify(input.stopConditions), input.bookingLink, input.assignedUserId,
    ],
  );
  return mapCampaign(rows[0]);
}

export async function updateCampaign(organizationId: string, campaignId: string, input: CampaignInput): Promise<Campaign | null> {
  const { rows } = await getPool().query(
    `UPDATE rescue_campaigns SET name = $3, template_key = $4, objective = $5, channel = $6, tone = $7,
       sender_identity = $8, audience = $9::jsonb, schedule = $10::jsonb, approval_mode = $11,
       follow_up_delay_days = $12, max_attempts = $13, stop_conditions = $14::jsonb, booking_link = $15,
       assigned_user_id = $16, updated_at = now()
     WHERE organization_id = $1 AND id = $2 AND status IN ('draft', 'paused')
     RETURNING ${CAMPAIGN_COLUMNS}`,
    [
      organizationId, campaignId, input.name, input.templateKey, input.objective, input.channel, input.tone,
      input.senderIdentity, JSON.stringify(input.audience), JSON.stringify(input.schedule), input.approvalMode,
      input.followUpDelayDays, input.maxAttempts, JSON.stringify(input.stopConditions), input.bookingLink, input.assignedUserId,
    ],
  );
  return rows[0] ? mapCampaign(rows[0]) : null;
}

export async function getCampaign(organizationId: string, campaignId: string): Promise<Campaign | null> {
  const { rows } = await getPool().query(
    `SELECT ${CAMPAIGN_COLUMNS} FROM rescue_campaigns WHERE organization_id = $1 AND id = $2`,
    [organizationId, campaignId],
  );
  return rows[0] ? mapCampaign(rows[0]) : null;
}

/**
 * Campaign list with per-campaign stats. When `assignedUserId` is set
 * (assigned-only roles, e.g. sales reps), only campaigns containing that
 * user's assigned leads are returned and every count is restricted to those
 * leads — org-wide campaign performance is manager-only data.
 */
export async function listCampaigns(
  organizationId: string,
  opts: { assignedUserId?: string } = {},
): Promise<Array<Campaign & { stats: CampaignStats }>> {
  const params: unknown[] = [organizationId];
  let campaignFilter = "";
  let clLeadScope = "";
  let msgLeadScope = "";
  let apptLeadScope = "";
  let valueLeadScope = "";
  let clickLeadScope = "";
  if (opts.assignedUserId) {
    params.push(opts.assignedUserId);
    campaignFilter = ` AND EXISTS (SELECT 1 FROM rescue_campaign_leads cl JOIN rescue_leads rl ON rl.id = cl.lead_id
      WHERE cl.campaign_id = rescue_campaigns.id AND rl.assigned_user_id = $2)`;
    clLeadScope = ` AND EXISTS (SELECT 1 FROM rescue_leads rl WHERE rl.id = rescue_campaign_leads.lead_id AND rl.assigned_user_id = $2)`;
    msgLeadScope = ` AND EXISTS (SELECT 1 FROM rescue_leads rl WHERE rl.id = rescue_messages.lead_id AND rl.assigned_user_id = $2)`;
    apptLeadScope = ` AND EXISTS (SELECT 1 FROM rescue_leads rl WHERE rl.id = rescue_appointments.lead_id AND rl.assigned_user_id = $2)`;
    valueLeadScope = ` AND l.assigned_user_id = $2`;
    clickLeadScope = ` AND EXISTS (SELECT 1 FROM rescue_leads rl WHERE rl.id = rescue_campaign_clicks.lead_id AND rl.assigned_user_id = $2)`;
  }
  const { rows } = await getPool().query(
    `SELECT ${CAMPAIGN_COLUMNS} FROM rescue_campaigns WHERE organization_id = $1${campaignFilter} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  const campaigns = rows.map(mapCampaign);
  const stats = new Map<string, CampaignStats>();
  for (const c of campaigns) stats.set(c.id, emptyStats());
  if (campaigns.length > 0) {
    const statRows = await getPool().query(
      `SELECT campaign_id,
         count(*)::int AS enrolled,
         count(*) FILTER (WHERE status IN ('messaged', 'replied', 'completed'))::int AS messaged,
         count(*) FILTER (WHERE status = 'replied')::int AS replies,
         count(*) FILTER (WHERE status = 'stopped' AND stop_reason = 'opt_out')::int AS opt_outs
       FROM rescue_campaign_leads WHERE organization_id = $1${clLeadScope} GROUP BY campaign_id`,
      params,
    );
    for (const row of statRows.rows) {
      const s = stats.get(row.campaign_id);
      if (s) Object.assign(s, { enrolled: row.enrolled, messaged: row.messaged, replies: row.replies, optOuts: row.opt_outs });
    }
    const messageRows = await getPool().query(
      `SELECT campaign_id,
         count(*) FILTER (WHERE direction = 'outbound' AND simulated)::int AS simulated_sends,
         count(*) FILTER (WHERE direction = 'outbound' AND NOT simulated AND status IN ('sent', 'delivered'))::int AS live_sends,
         count(*) FILTER (WHERE direction = 'outbound' AND status = 'delivered')::int AS delivered
       FROM rescue_messages WHERE organization_id = $1 AND campaign_id IS NOT NULL${msgLeadScope} GROUP BY campaign_id`,
      params,
    );
    for (const row of messageRows.rows) {
      const s = stats.get(row.campaign_id);
      if (s) Object.assign(s, { simulatedSends: row.simulated_sends, liveSends: row.live_sends, delivered: row.delivered });
    }
    const apptRows = await getPool().query(
      `SELECT campaign_id, count(*)::int AS appointments FROM rescue_appointments
       WHERE organization_id = $1 AND campaign_id IS NOT NULL AND status NOT IN ('cancelled')${apptLeadScope} GROUP BY campaign_id`,
      params,
    );
    for (const row of apptRows.rows) {
      const s = stats.get(row.campaign_id);
      if (s) s.appointments = row.appointments;
    }
    const valueRows = await getPool().query(
      `SELECT cl.campaign_id, COALESCE(sum(l.estimated_value), 0)::numeric AS pipeline_value
       FROM rescue_campaign_leads cl JOIN rescue_leads l ON l.id = cl.lead_id AND l.organization_id = cl.organization_id
       WHERE cl.organization_id = $1 AND cl.status = 'replied'
         AND l.pipeline_stage IN ('replied', 'qualified', 'appointment_booked', 'estimate_issued', 'won')${valueLeadScope}
       GROUP BY cl.campaign_id`,
      params,
    );
    for (const row of valueRows.rows) {
      const s = stats.get(row.campaign_id);
      if (s) s.pipelineValue = Number(row.pipeline_value);
    }
    const clickRows = await getPool().query(
      `SELECT campaign_id, count(*)::int AS link_clicks
       FROM rescue_campaign_clicks WHERE organization_id = $1${clickLeadScope} GROUP BY campaign_id`,
      params,
    );
    for (const row of clickRows.rows) {
      const s = stats.get(row.campaign_id);
      if (s) s.linkClicks = row.link_clicks;
    }
  }
  return campaigns.map((c) => ({ ...c, stats: stats.get(c.id) ?? emptyStats() }));
}

function emptyStats(): CampaignStats {
  return { enrolled: 0, messaged: 0, simulatedSends: 0, liveSends: 0, delivered: 0, replies: 0, optOuts: 0, appointments: 0, pipelineValue: 0, linkClicks: 0 };
}

export async function getCampaignStats(
  organizationId: string,
  campaignId: string,
  opts: { assignedUserId?: string } = {},
): Promise<CampaignStats> {
  const all = await listCampaigns(organizationId, opts);
  return all.find((c) => c.id === campaignId)?.stats ?? emptyStats();
}

export async function setCampaignStatus(
  organizationId: string,
  campaignId: string,
  status: CampaignStatus,
  activation?: { activatedBy: string | null; mode: "simulation" | "live" },
): Promise<Campaign | null> {
  const { rows } = activation
    ? await getPool().query(
        `UPDATE rescue_campaigns SET status = $3, mode = $4, activated_at = now(), activated_by = $5, updated_at = now()
         WHERE organization_id = $1 AND id = $2 RETURNING ${CAMPAIGN_COLUMNS}`,
        [organizationId, campaignId, status, activation.mode, activation.activatedBy],
      )
    : await getPool().query(
        `UPDATE rescue_campaigns SET status = $3, updated_at = now()
         WHERE organization_id = $1 AND id = $2 RETURNING ${CAMPAIGN_COLUMNS}`,
        [organizationId, campaignId, status],
      );
  return rows[0] ? mapCampaign(rows[0]) : null;
}

export async function deleteDraftCampaign(organizationId: string, campaignId: string): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM rescue_campaigns WHERE organization_id = $1 AND id = $2 AND status = 'draft'",
    [organizationId, campaignId],
  );
  return (result.rowCount ?? 0) > 0;
}

// ---- Campaign enrollment ---------------------------------------------------------

export async function enrollCampaignLeads(organizationId: string, campaignId: string, leadIds: string[]): Promise<number> {
  if (leadIds.length === 0) return 0;
  const result = await getPool().query(
    `INSERT INTO rescue_campaign_leads (organization_id, campaign_id, lead_id)
     SELECT $1, $2, unnest($3::uuid[])
     ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
    [organizationId, campaignId, leadIds],
  );
  return result.rowCount ?? 0;
}

export type CampaignLeadRow = {
  leadId: string;
  status: string;
  stopReason: string | null;
  attempts: number;
  lastMessageAt: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  score: number | null;
  category: string | null;
  pipelineStage: string;
};

export async function listCampaignLeads(
  organizationId: string,
  campaignId: string,
  limit = 100,
  opts: { assignedUserId?: string } = {},
): Promise<CampaignLeadRow[]> {
  const params: unknown[] = [organizationId, campaignId, Math.min(limit, 500)];
  let leadScope = "";
  if (opts.assignedUserId) {
    // Assigned-only roles never see other users' enrolled leads.
    params.push(opts.assignedUserId);
    leadScope = ` AND l.assigned_user_id = $${params.length}`;
  }
  const { rows } = await getPool().query(
    `SELECT cl.lead_id, cl.status, cl.stop_reason, cl.attempts, cl.last_message_at,
       l.first_name, l.last_name, l.email, l.phone, l.score, l.category, l.pipeline_stage
     FROM rescue_campaign_leads cl JOIN rescue_leads l ON l.id = cl.lead_id AND l.organization_id = cl.organization_id
     WHERE cl.organization_id = $1 AND cl.campaign_id = $2${leadScope}
     ORDER BY l.score DESC NULLS LAST, cl.created_at ASC LIMIT $3`,
    params,
  );
  return rows.map((row) => ({
    leadId: row.lead_id,
    status: row.status,
    stopReason: row.stop_reason,
    attempts: row.attempts,
    lastMessageAt: row.last_message_at,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    score: row.score,
    category: row.category,
    pipelineStage: row.pipeline_stage,
  }));
}

export async function markCampaignLeadMessaged(organizationId: string, campaignId: string, leadId: string): Promise<void> {
  await getPool().query(
    `UPDATE rescue_campaign_leads SET status = 'messaged', attempts = attempts + 1, last_message_at = now()
     WHERE organization_id = $1 AND campaign_id = $2 AND lead_id = $3 AND status IN ('enrolled', 'messaged')`,
    [organizationId, campaignId, leadId],
  );
}

export async function markCampaignLeadReplied(organizationId: string, leadId: string, campaignId?: string | null): Promise<void> {
  const params: unknown[] = [organizationId, leadId];
  let scope = "";
  if (campaignId) {
    params.push(campaignId);
    scope = ` AND campaign_id = $${params.length}`;
  }
  await getPool().query(
    `UPDATE rescue_campaign_leads SET status = 'replied' WHERE organization_id = $1 AND lead_id = $2 AND status IN ('enrolled', 'messaged')${scope}`,
    params,
  );
}

/** Stops automation for a lead — one campaign or all. Used by reply rules and suppression. */
export async function stopCampaignLeads(
  organizationId: string,
  leadId: string,
  reason: string,
  campaignId?: string | null,
): Promise<number> {
  const params: unknown[] = [organizationId, leadId, reason];
  let scope = "";
  if (campaignId) {
    params.push(campaignId);
    scope = ` AND campaign_id = $${params.length}`;
  }
  const result = await getPool().query(
    `UPDATE rescue_campaign_leads SET status = 'stopped', stop_reason = $3
     WHERE organization_id = $1 AND lead_id = $2 AND status IN ('enrolled', 'messaged')${scope}`,
    params,
  );
  return result.rowCount ?? 0;
}

// ---- Messages / conversations ----------------------------------------------------

export type MessageRecord = {
  id: string;
  leadId: string;
  campaignId: string | null;
  direction: "outbound" | "inbound";
  channel: string;
  subject: string | null;
  body: string;
  status: string;
  simulated: boolean;
  provider: string;
  providerMessageId: string | null;
  replyCategory: ReplyCategory | null;
  replyConfidence: number | null;
  replyRule: string | null;
  createdBy: string | null;
  sentAt: string | null;
  createdAt: string;
};

const MESSAGE_COLUMNS = `id, lead_id, campaign_id, direction, channel, subject, body, status, simulated, provider,
  provider_message_id, reply_category, reply_confidence, reply_rule, created_by, sent_at, created_at`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapMessage(row: any): MessageRecord {
  return {
    id: row.id,
    leadId: row.lead_id,
    campaignId: row.campaign_id,
    direction: row.direction,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    status: row.status,
    simulated: row.simulated,
    provider: row.provider,
    providerMessageId: row.provider_message_id ?? null,
    replyCategory: row.reply_category,
    replyConfidence: row.reply_confidence != null ? Number(row.reply_confidence) : null,
    replyRule: row.reply_rule,
    createdBy: row.created_by,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

export async function insertMessage(input: {
  organizationId: string;
  leadId: string;
  campaignId?: string | null;
  direction: "outbound" | "inbound";
  channel: string;
  subject?: string | null;
  body: string;
  status: string;
  simulated: boolean;
  provider?: string;
  providerMessageId?: string | null;
  createdBy?: string | null;
  replyCategory?: ReplyCategory | null;
  replyConfidence?: number | null;
  replyRule?: string | null;
}): Promise<MessageRecord> {
  const { rows } = await getPool().query(
    `INSERT INTO rescue_messages (organization_id, lead_id, campaign_id, direction, channel, subject, body, status,
       simulated, provider, provider_message_id, created_by, reply_category, reply_confidence, reply_rule, sent_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CASE WHEN $4 = 'outbound' THEN now() ELSE NULL END)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      input.organizationId, input.leadId, input.campaignId ?? null, input.direction, input.channel,
      input.subject ?? null, input.body, input.status, input.simulated, input.provider ?? "simulation",
      input.providerMessageId ?? null, input.createdBy ?? null, input.replyCategory ?? null,
      input.replyConfidence ?? null, input.replyRule ?? null,
    ],
  );
  return mapMessage(rows[0]);
}

/**
 * Marks a live outbound message's send outcome. Only touches non-simulated
 * outbound rows — the simulation-honesty CHECK constraint backs this up.
 */
export async function markMessageSendOutcome(
  organizationId: string,
  messageId: string,
  outcome: { status: "sent" | "failed"; providerMessageId?: string | null },
): Promise<void> {
  await getPool().query(
    `UPDATE rescue_messages SET status = $3, provider_message_id = COALESCE($4, provider_message_id)
     WHERE organization_id = $1 AND id = $2 AND direction = 'outbound' AND simulated = false`,
    [organizationId, messageId, outcome.status, outcome.providerMessageId ?? null],
  );
}

/**
 * Applies a provider delivery-status callback (delivered/failed) to the live
 * outbound message it belongs to. Status only moves forward (queued → sent →
 * delivered/failed); simulated rows can never be touched. Returns the updated
 * message or null when no matching live message exists.
 */
export async function applyDeliveryStatus(
  provider: string,
  providerMessageId: string,
  status: "sent" | "delivered" | "failed",
): Promise<{ message: MessageRecord; organizationId: string } | null> {
  const { rows } = await getPool().query(
    `UPDATE rescue_messages SET status = $3
     WHERE provider = $1 AND provider_message_id = $2 AND direction = 'outbound' AND simulated = false
       AND status IN ('queued', 'sent') AND ($3 <> 'sent' OR status = 'queued')
     RETURNING ${MESSAGE_COLUMNS}, organization_id`,
    [provider, providerMessageId, status],
  );
  return rows[0] ? { message: mapMessage(rows[0]), organizationId: rows[0].organization_id } : null;
}

/**
 * Resolves the lead an inbound webhook message (SMS from a phone number, email
 * reply from an address) belongs to. Provider webhooks are platform-wide, not
 * org-scoped, so when the same contact exists in several orgs the lead with
 * the most recent live outbound message on that channel wins.
 */
export async function findLeadForInboundContact(
  channel: "sms" | "email",
  normalizedContact: string,
): Promise<{ organizationId: string; leadId: string } | null> {
  const contactColumn = channel === "sms" ? "phone_normalized" : "email_normalized";
  const { rows } = await getPool().query(
    `SELECT l.organization_id, l.id,
       (SELECT max(m.created_at) FROM rescue_messages m
         WHERE m.organization_id = l.organization_id AND m.lead_id = l.id
           AND m.direction = 'outbound' AND m.simulated = false AND m.channel = $2) AS last_live_outbound
     FROM rescue_leads l
     WHERE l.${contactColumn} = $1
     ORDER BY last_live_outbound DESC NULLS LAST, l.updated_at DESC
     LIMIT 1`,
    [normalizedContact, channel],
  );
  return rows[0] ? { organizationId: rows[0].organization_id, leadId: rows[0].id } : null;
}

export async function listLeadMessages(organizationId: string, leadId: string, limit = 200): Promise<MessageRecord[]> {
  const { rows } = await getPool().query(
    `SELECT ${MESSAGE_COLUMNS} FROM rescue_messages WHERE organization_id = $1 AND lead_id = $2 ORDER BY created_at ASC LIMIT $3`,
    [organizationId, leadId, Math.min(limit, 500)],
  );
  return rows.map(mapMessage);
}

/** Latest outbound campaign message for a lead — used to attribute an inbound reply to a campaign. */
export async function latestOutboundCampaignId(organizationId: string, leadId: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT campaign_id FROM rescue_messages
     WHERE organization_id = $1 AND lead_id = $2 AND direction = 'outbound' AND campaign_id IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [organizationId, leadId],
  );
  return rows[0]?.campaign_id ?? null;
}

export type ConversationThread = {
  leadId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  score: number | null;
  category: string | null;
  pipelineStage: string;
  suppressed: boolean;
  assignedUserId: string | null;
  assignedName: string | null;
  messageCount: number;
  inboundCount: number;
  lastMessageAt: string;
  lastDirection: string;
  lastBody: string;
  lastReplyCategory: string | null;
  lastSimulated: boolean;
};

export async function listConversations(
  organizationId: string,
  opts: { assignedUserId?: string; limit?: number } = {},
): Promise<ConversationThread[]> {
  const params: unknown[] = [organizationId];
  let assignedFilter = "";
  if (opts.assignedUserId) {
    params.push(opts.assignedUserId);
    assignedFilter = ` AND l.assigned_user_id = $${params.length}`;
  }
  params.push(Math.min(opts.limit ?? 50, 200));
  const { rows } = await getPool().query(
    `SELECT t.lead_id, t.message_count, t.inbound_count, t.last_message_at,
       l.first_name, l.last_name, l.email, l.phone, l.score, l.category, l.pipeline_stage, l.suppressed,
       l.assigned_user_id, u.name AS assigned_name,
       m.direction AS last_direction, m.body AS last_body, m.reply_category AS last_reply_category, m.simulated AS last_simulated
     FROM (
       SELECT lead_id, count(*)::int AS message_count,
         count(*) FILTER (WHERE direction = 'inbound')::int AS inbound_count,
         max(created_at) AS last_message_at
       FROM rescue_messages WHERE organization_id = $1 GROUP BY lead_id
     ) t
     JOIN rescue_leads l ON l.id = t.lead_id AND l.organization_id = $1
     LEFT JOIN users u ON u.id = l.assigned_user_id
     JOIN LATERAL (
       SELECT direction, body, reply_category, simulated FROM rescue_messages
       WHERE organization_id = $1 AND lead_id = t.lead_id ORDER BY created_at DESC LIMIT 1
     ) m ON true
     WHERE true${assignedFilter}
     ORDER BY t.last_message_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    leadId: row.lead_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    score: row.score,
    category: row.category,
    pipelineStage: row.pipeline_stage,
    suppressed: row.suppressed,
    assignedUserId: row.assigned_user_id,
    assignedName: row.assigned_name,
    messageCount: row.message_count,
    inboundCount: row.inbound_count,
    lastMessageAt: row.last_message_at,
    lastDirection: row.last_direction,
    lastBody: row.last_body,
    lastReplyCategory: row.last_reply_category,
    lastSimulated: row.last_simulated,
  }));
}

// ---- Lead engagement actions -----------------------------------------------------

export async function assignLead(organizationId: string, leadId: string, userId: string | null): Promise<boolean> {
  const result = await getPool().query(
    "UPDATE rescue_leads SET assigned_user_id = $3, updated_at = now() WHERE organization_id = $1 AND id = $2",
    [organizationId, leadId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Moves a lead's pipeline stage. Suppressed leads never leave 'suppressed' except via un-suppression (not offered). */
export async function setLeadStage(
  organizationId: string,
  leadId: string,
  stage: PipelineStage,
  opts: { wonValue?: number | null } = {},
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE rescue_leads SET pipeline_stage = $3, stage_changed_at = now(), updated_at = now(),
       won_value = CASE WHEN $3 = 'won' THEN COALESCE($4::numeric, won_value, estimated_value) ELSE won_value END
     WHERE organization_id = $1 AND id = $2 AND pipeline_stage <> 'suppressed'`,
    [organizationId, leadId, stage, opts.wonValue ?? null],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Suppresses a contact immediately and unconditionally: flags the lead, writes
 * suppression records for its email/phone, marks consent opted-out when the
 * suppression came from an opt-out, and stops all campaign automation.
 */
export async function suppressLeadContact(
  organizationId: string,
  leadId: string,
  reason: string,
  opts: { optOut: boolean },
): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE rescue_leads SET suppressed = true, suppression_reason = $3,
       consent_status = CASE WHEN $4 THEN 'opted_out' ELSE consent_status END,
       pipeline_stage = 'suppressed', stage_changed_at = now(), updated_at = now()
     WHERE organization_id = $1 AND id = $2
     RETURNING email_normalized, phone_normalized`,
    [organizationId, leadId, reason, opts.optOut],
  );
  const lead = rows[0];
  if (!lead) return;
  const type = opts.optOut ? "opt_out" : "manual";
  if (lead.email_normalized) {
    await pool.query(
      `INSERT INTO suppression_records (organization_id, channel, value, reason, source)
       VALUES ($1, 'email', $2, $3, $4) ON CONFLICT DO NOTHING`,
      [organizationId, lead.email_normalized, type, reason],
    );
  }
  if (lead.phone_normalized) {
    await pool.query(
      `INSERT INTO suppression_records (organization_id, channel, value, reason, source)
       VALUES ($1, 'phone', $2, $3, $4) ON CONFLICT DO NOTHING`,
      [organizationId, lead.phone_normalized, type, reason],
    );
  }
  await stopCampaignLeads(organizationId, leadId, opts.optOut ? "opt_out" : "suppressed");
}

/** Sales-rep guard for bulk actions: keeps only the ids actually assigned to the user. */
export async function filterLeadsAssignedTo(organizationId: string, leadIds: string[], userId: string): Promise<string[]> {
  if (leadIds.length === 0) return [];
  const { rows } = await getPool().query(
    "SELECT id FROM rescue_leads WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND assigned_user_id = $3",
    [organizationId, leadIds, userId],
  );
  return rows.map((row) => row.id);
}

export async function addLeadNote(organizationId: string, leadId: string, note: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE rescue_leads SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $3 ELSE notes || E'\\n' || $3 END, updated_at = now()
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, leadId, note],
  );
  return (result.rowCount ?? 0) > 0;
}

export type LeadEngagement = {
  assignedUserId: string | null;
  assignedName: string | null;
  pipelineStage: PipelineStage;
  wonValue: number | null;
  campaigns: Array<{ campaignId: string; name: string; status: string; stopReason: string | null }>;
};

export async function getLeadEngagement(organizationId: string, leadId: string): Promise<LeadEngagement | null> {
  const { rows } = await getPool().query(
    `SELECT l.assigned_user_id, u.name AS assigned_name, l.pipeline_stage, l.won_value
     FROM rescue_leads l LEFT JOIN users u ON u.id = l.assigned_user_id
     WHERE l.organization_id = $1 AND l.id = $2`,
    [organizationId, leadId],
  );
  const row = rows[0];
  if (!row) return null;
  const campaignRows = await getPool().query(
    `SELECT cl.campaign_id, c.name, cl.status, cl.stop_reason
     FROM rescue_campaign_leads cl JOIN rescue_campaigns c ON c.id = cl.campaign_id
     WHERE cl.organization_id = $1 AND cl.lead_id = $2 ORDER BY cl.created_at DESC LIMIT 20`,
    [organizationId, leadId],
  );
  return {
    assignedUserId: row.assigned_user_id,
    assignedName: row.assigned_name,
    pipelineStage: row.pipeline_stage,
    wonValue: row.won_value != null ? Number(row.won_value) : null,
    campaigns: campaignRows.rows.map((r) => ({ campaignId: r.campaign_id, name: r.name, status: r.status, stopReason: r.stop_reason })),
  };
}

// ---- Appointments ----------------------------------------------------------------

export type Appointment = {
  id: string;
  leadId: string;
  campaignId: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  appointmentType: AppointmentType;
  scheduledStart: string;
  scheduledEnd: string | null;
  timezone: string | null;
  address: string | null;
  projectDetails: string | null;
  status: AppointmentStatus;
  provider: AppointmentProvider;
  externalEventId: string | null;
  /** Which credentials created the external event; null when unsynced. Legacy rows default to "workspace" via backfill. */
  externalCredentialSource: "org" | "workspace" | null;
  notes: string | null;
  leadFirstName: string | null;
  leadLastName: string | null;
  leadPhone: string | null;
  leadEmail: string | null;
  createdAt: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapAppointment(row: any): Appointment {
  return {
    id: row.id,
    leadId: row.lead_id,
    campaignId: row.campaign_id,
    assignedUserId: row.assigned_user_id,
    assignedName: row.assigned_name ?? null,
    appointmentType: row.appointment_type,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    timezone: row.timezone,
    address: row.address,
    projectDetails: row.project_details,
    status: row.status,
    provider: row.provider,
    externalEventId: row.external_event_id,
    externalCredentialSource: row.external_credential_source ?? (row.external_event_id ? "workspace" : null),
    notes: row.notes,
    leadFirstName: row.lead_first_name ?? null,
    leadLastName: row.lead_last_name ?? null,
    leadPhone: row.lead_phone ?? null,
    leadEmail: row.lead_email ?? null,
    createdAt: row.created_at,
  };
}

const APPOINTMENT_SELECT = `SELECT a.*, u.name AS assigned_name,
    l.first_name AS lead_first_name, l.last_name AS lead_last_name, l.phone AS lead_phone, l.email AS lead_email
  FROM rescue_appointments a
  JOIN rescue_leads l ON l.id = a.lead_id AND l.organization_id = a.organization_id
  LEFT JOIN users u ON u.id = a.assigned_user_id`;

export async function createAppointment(input: {
  organizationId: string;
  leadId: string;
  campaignId?: string | null;
  assignedUserId?: string | null;
  appointmentType: AppointmentType;
  scheduledStart: string;
  scheduledEnd?: string | null;
  timezone?: string | null;
  address?: string | null;
  projectDetails?: string | null;
  notes?: string | null;
  createdBy: string | null;
  /** Where the booking originated ('manual' unless it came via a booking link or external calendar). */
  provider?: AppointmentProvider;
  externalEventId?: string | null;
}): Promise<Appointment | null> {
  const { rows } = await getPool().query(
    `INSERT INTO rescue_appointments (organization_id, lead_id, campaign_id, assigned_user_id, appointment_type,
       scheduled_start, scheduled_end, timezone, address, project_details, notes, created_by, provider, external_event_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'requested')
     RETURNING id`,
    [
      input.organizationId, input.leadId, input.campaignId ?? null, input.assignedUserId ?? null, input.appointmentType,
      input.scheduledStart, input.scheduledEnd ?? null, input.timezone ?? null, input.address ?? null,
      input.projectDetails ?? null, input.notes ?? null, input.createdBy, input.provider ?? "manual", input.externalEventId ?? null,
    ],
  );
  return getAppointment(input.organizationId, rows[0].id);
}

/** Records the external calendar event backing an appointment (after a successful push). */
export async function setAppointmentExternalRef(
  organizationId: string,
  appointmentId: string,
  provider: AppointmentProvider,
  externalEventId: string | null,
  credentialSource: "org" | "workspace" | null = null,
): Promise<void> {
  await getPool().query(
    `UPDATE rescue_appointments SET provider = $3, external_event_id = $4, external_credential_source = $5, updated_at = now()
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, appointmentId, provider, externalEventId, externalEventId ? credentialSource : null],
  );
}
export async function getAppointment(organizationId: string, appointmentId: string): Promise<Appointment | null> {
  const { rows } = await getPool().query(
    `${APPOINTMENT_SELECT} WHERE a.organization_id = $1 AND a.id = $2`,
    [organizationId, appointmentId],
  );
  return rows[0] ? mapAppointment(rows[0]) : null;
}

export async function listAppointments(
  organizationId: string,
  opts: { assignedUserId?: string; status?: AppointmentStatus; limit?: number } = {},
): Promise<Appointment[]> {
  const params: unknown[] = [organizationId];
  const where: string[] = ["a.organization_id = $1"];
  if (opts.assignedUserId) {
    params.push(opts.assignedUserId);
    where.push(`(a.assigned_user_id = $${params.length} OR l.assigned_user_id = $${params.length})`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`a.status = $${params.length}`);
  }
  params.push(Math.min(opts.limit ?? 100, 300));
  const { rows } = await getPool().query(
    `${APPOINTMENT_SELECT} WHERE ${where.join(" AND ")} ORDER BY a.scheduled_start DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapAppointment);
}

export async function updateAppointment(
  organizationId: string,
  appointmentId: string,
  patch: Partial<{ status: AppointmentStatus; scheduledStart: string; scheduledEnd: string | null; assignedUserId: string | null; notes: string | null; address: string | null }>,
): Promise<Appointment | null> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [organizationId, appointmentId];
  const columnFor: Record<string, string> = {
    status: "status",
    scheduledStart: "scheduled_start",
    scheduledEnd: "scheduled_end",
    assignedUserId: "assigned_user_id",
    notes: "notes",
    address: "address",
  };
  for (const [key, column] of Object.entries(columnFor)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  const result = await getPool().query(
    `UPDATE rescue_appointments SET ${sets.join(", ")} WHERE organization_id = $1 AND id = $2`,
    params,
  );
  if ((result.rowCount ?? 0) === 0) return null;
  return getAppointment(organizationId, appointmentId);
}

// ---- Activities ------------------------------------------------------------------

export type Activity = {
  id: string;
  leadId: string | null;
  campaignId: string | null;
  activityType: string;
  title: string;
  detail: string | null;
  metadata: Record<string, unknown>;
  actorUserId: string | null;
  createdAt: string;
};

export async function logActivity(input: {
  organizationId: string;
  leadId?: string | null;
  campaignId?: string | null;
  activityType: string;
  title: string;
  detail?: string | null;
  metadata?: Record<string, unknown>;
  actorUserId?: string | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO rescue_activities (organization_id, lead_id, campaign_id, activity_type, title, detail, metadata, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      input.organizationId, input.leadId ?? null, input.campaignId ?? null, input.activityType,
      input.title, input.detail ?? null, JSON.stringify(input.metadata ?? {}), input.actorUserId ?? null,
    ],
  );
}

export async function listActivities(
  organizationId: string,
  opts: { leadId?: string; assignedUserId?: string; limit?: number } = {},
): Promise<Activity[]> {
  const params: unknown[] = [organizationId];
  let leadFilter = "";
  if (opts.leadId) {
    params.push(opts.leadId);
    leadFilter = ` AND lead_id = $${params.length}`;
  }
  if (opts.assignedUserId) {
    // Assigned-only roles: only activities on their own leads. Org-level
    // activities (lead_id IS NULL, e.g. campaign activations) are hidden —
    // they cannot be attributed to an assignment and would leak org-wide data.
    params.push(opts.assignedUserId);
    leadFilter += ` AND lead_id IN (SELECT id FROM rescue_leads WHERE organization_id = $1 AND assigned_user_id = $${params.length})`;
  }
  params.push(Math.min(opts.limit ?? 20, 100));
  const { rows } = await getPool().query(
    `SELECT id, lead_id, campaign_id, activity_type, title, detail, metadata, actor_user_id, created_at
     FROM rescue_activities WHERE organization_id = $1${leadFilter} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: String(row.id),
    leadId: row.lead_id,
    campaignId: row.campaign_id,
    activityType: row.activity_type,
    title: row.title,
    detail: row.detail,
    metadata: row.metadata ?? {},
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  }));
}

// ---- Tasks -----------------------------------------------------------------------

export type Task = {
  id: string;
  leadId: string | null;
  campaignId: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  title: string;
  detail: string | null;
  dueAt: string | null;
  status: "open" | "done" | "dismissed";
  source: "manual" | "reply_rule" | "escalation";
  leadFirstName: string | null;
  leadLastName: string | null;
  createdAt: string;
};

export async function createTask(input: {
  organizationId: string;
  leadId?: string | null;
  campaignId?: string | null;
  assignedUserId?: string | null;
  title: string;
  detail?: string | null;
  dueAt?: string | null;
  source: "manual" | "reply_rule" | "escalation";
  createdBy?: string | null;
}): Promise<string> {
  const { rows } = await getPool().query(
    `INSERT INTO rescue_tasks (organization_id, lead_id, campaign_id, assigned_user_id, title, detail, due_at, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      input.organizationId, input.leadId ?? null, input.campaignId ?? null, input.assignedUserId ?? null,
      input.title, input.detail ?? null, input.dueAt ?? null, input.source, input.createdBy ?? null,
    ],
  );
  return rows[0].id;
}

export async function listTasks(
  organizationId: string,
  opts: { assignedUserId?: string; status?: "open" | "done" | "dismissed"; leadId?: string; limit?: number } = {},
): Promise<Task[]> {
  const params: unknown[] = [organizationId];
  const where: string[] = ["t.organization_id = $1"];
  if (opts.assignedUserId) {
    // Assigned-only roles: tasks explicitly assigned to them, or tasks on
    // leads assigned to them. Unassigned org-wide tasks stay manager-only.
    params.push(opts.assignedUserId);
    where.push(`(t.assigned_user_id = $${params.length} OR l.assigned_user_id = $${params.length})`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`t.status = $${params.length}`);
  }
  if (opts.leadId) {
    params.push(opts.leadId);
    where.push(`t.lead_id = $${params.length}`);
  }
  params.push(Math.min(opts.limit ?? 50, 200));
  const { rows } = await getPool().query(
    `SELECT t.*, u.name AS assigned_name, l.first_name AS lead_first_name, l.last_name AS lead_last_name
     FROM rescue_tasks t
     LEFT JOIN users u ON u.id = t.assigned_user_id
     LEFT JOIN rescue_leads l ON l.id = t.lead_id
     WHERE ${where.join(" AND ")}
     ORDER BY t.status = 'open' DESC, t.due_at ASC NULLS FIRST, t.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    campaignId: row.campaign_id,
    assignedUserId: row.assigned_user_id,
    assignedName: row.assigned_name,
    title: row.title,
    detail: row.detail,
    dueAt: row.due_at,
    status: row.status,
    source: row.source,
    leadFirstName: row.lead_first_name,
    leadLastName: row.lead_last_name,
    createdAt: row.created_at,
  }));
}

/** Ownership facts for a task, used for assigned-only role authorization. */
export async function getTaskOwnership(
  organizationId: string,
  taskId: string,
): Promise<{ assignedUserId: string | null; leadAssignedUserId: string | null } | null> {
  const { rows } = await getPool().query(
    `SELECT t.assigned_user_id, l.assigned_user_id AS lead_assigned_user_id
     FROM rescue_tasks t LEFT JOIN rescue_leads l ON l.id = t.lead_id
     WHERE t.organization_id = $1 AND t.id = $2`,
    [organizationId, taskId],
  );
  if (rows.length === 0) return null;
  return { assignedUserId: rows[0].assigned_user_id, leadAssignedUserId: rows[0].lead_assigned_user_id };
}

export async function setTaskStatus(organizationId: string, taskId: string, status: "open" | "done" | "dismissed"): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE rescue_tasks SET status = $3, completed_at = CASE WHEN $3 = 'done' THEN now() ELSE completed_at END
     WHERE organization_id = $1 AND id = $2`,
    [organizationId, taskId, status],
  );
  return (result.rowCount ?? 0) > 0;
}

export type SyncedAppointmentRef = {
  id: string;
  organizationId: string;
  provider: AppointmentProvider;
  externalEventId: string;
  /** Which credentials created the external event ("workspace" for pre-OAuth legacy rows). */
  credentialSource: "org" | "workspace";
  scheduledStart: string;
  scheduledEnd: string | null;
  status: AppointmentStatus;
};

/** All appointments (across orgs) backed by an external calendar event that could still change. Used by the sync cron. */
export async function listSyncedAppointmentRefs(providers: AppointmentProvider[]): Promise<SyncedAppointmentRef[]> {
  if (providers.length === 0) return [];
  const { rows } = await getPool().query(
    `SELECT id, organization_id, provider, external_event_id, external_credential_source, scheduled_start, scheduled_end, status
     FROM rescue_appointments
     WHERE provider = ANY($1) AND external_event_id IS NOT NULL
       AND status IN ('requested', 'confirmed', 'rescheduled')
     ORDER BY scheduled_start ASC
     LIMIT 500`,
    [providers],
  );
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    externalEventId: row.external_event_id,
    credentialSource: row.external_credential_source === "org" ? "org" : "workspace",
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    status: row.status,
  }));
}

/** Simple email match used to attach inbound Calendly/booking-page bookings to an existing lead. */
export async function findLeadIdByEmail(organizationId: string, email: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT id FROM rescue_leads WHERE organization_id = $1 AND lower(email) = lower($2) ORDER BY created_at DESC LIMIT 1`,
    [organizationId, email],
  );
  return rows[0]?.id ?? null;
}

/**
 * Records a booking-link click for a campaign lead (deduped: first visit wins).
 * Only called when the token carries both a campaign claim and a lead claim.
 * Concurrent page loads are safe — the primary key constraint silently ignores
 * duplicate inserts.
 */
export async function recordCampaignClick(organizationId: string, campaignId: string, leadId: string): Promise<void> {
  // Insert only when both the campaign and the lead actually exist and belong
  // to the same org — the SELECT guards against stale tokens referencing
  // deleted rows, eliminating any FK violation risk.  ON CONFLICT deduplicates
  // repeat visits from the same lead.
  await getPool().query(
    `INSERT INTO rescue_campaign_clicks (organization_id, campaign_id, lead_id)
     SELECT $1, c.id, l.id
     FROM rescue_campaigns c
     JOIN rescue_leads l ON l.organization_id = c.organization_id
     WHERE c.organization_id = $1 AND c.id = $2 AND l.id = $3
     ON CONFLICT (campaign_id, lead_id) DO NOTHING`,
    [organizationId, campaignId, leadId],
  );
}

/** True when an external event id is already tracked for the org (dedupe for inbound sync). */
export async function externalEventExists(organizationId: string, externalEventId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM rescue_appointments WHERE organization_id = $1 AND external_event_id = $2 LIMIT 1`,
    [organizationId, externalEventId],
  );
  return rows.length > 0;
}
