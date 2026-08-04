import "server-only";
import { getPool } from "../db";
import { getEffectiveBranding } from "../branding";
import { buildTemplateDraft } from "../rescue-analysis/message-content.ts";
import { mapLeadFacts, LEAD_FACT_COLUMNS } from "../rescue-analysis/store";
import { recordUsage, requireActionCapacity } from "../usage";
import { hourInTimeZone, type CampaignTone } from "./campaign-schema.ts";
import {
  insertMessage,
  logActivity,
  markCampaignLeadMessaged,
  stopCampaignLeads,
} from "./store.ts";

/**
 * Follow-up send scheduler. Periodically (see instrumentation.ts) finds active
 * campaigns whose enrolled leads are due for attempt 2..N based on the
 * campaign's follow-up cadence (followUpDelayDays, maxAttempts), and records
 * the next touch.
 *
 * Safety rules — the same guarantees as first-touch activation:
 * - Only simulation-mode campaigns are processed. Live mode has no provider
 *   yet; if a live campaign ever shows up active it is skipped loudly, never
 *   silently simulated as delivered. The rescue_messages_simulation_honesty
 *   DB constraint backs this up.
 * - Suppression / opt-out is re-checked per lead at send time; violating leads
 *   are stopped, not messaged.
 * - Stop conditions are enforced: reply (lead status leaves 'messaged'),
 *   appointment_booked (any non-cancelled appointment), max_attempts.
 * - Quiet hours from the campaign schedule are respected — nothing sends at or
 *   after quietHoursStart, or before quietHoursEnd — evaluated in the
 *   organization's configured time zone (organizations.timezone), not the
 *   server's clock.
 * - Plan capacity is checked per campaign; a campaign over its send limit is
 *   skipped this pass (never partially over-sent), and every simulated send is
 *   metered like activation sends are.
 */

const FOLLOW_UP_BATCH_LIMIT = 200;

export type FollowUpPassResult = {
  campaignsChecked: number;
  followUpsSent: number;
  leadsStopped: number;
  skipped: number;
};

/** True when `hour` falls inside the campaign's quiet window. */
export function isQuietHour(hour: number, quietStart: number, quietEnd: number): boolean {
  if (quietStart === quietEnd) return false; // degenerate config — no quiet window
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  // Typical overnight window, e.g. 20 → 8.
  return hour >= quietStart || hour < quietEnd;
}

export async function runFollowUpPass(now: Date = new Date()): Promise<FollowUpPassResult> {
  const result: FollowUpPassResult = { campaignsChecked: 0, followUpsSent: 0, leadsStopped: 0, skipped: 0 };

  // Loud skip for any active live-mode campaign — should be impossible today.
  const live = await getPool().query(
    `SELECT id, name FROM rescue_campaigns WHERE status = 'active' AND mode = 'live' LIMIT 5`,
  );
  for (const row of live.rows) {
    console.warn(`Follow-up scheduler: campaign "${row.name}" (${row.id}) is active in live mode but no provider is connected — skipping.`);
  }

  const { rows } = await getPool().query(
    `SELECT c.organization_id, c.id, c.name, c.channel, c.tone, c.objective, c.schedule,
       c.follow_up_delay_days, c.max_attempts, c.stop_conditions, c.mode, c.status,
       o.timezone AS org_timezone
     FROM rescue_campaigns c
     JOIN organizations o ON o.id = c.organization_id
     WHERE c.status = 'active' AND c.mode = 'simulation'
       AND EXISTS (
         SELECT 1 FROM rescue_campaign_leads cl
         WHERE cl.organization_id = c.organization_id AND cl.campaign_id = c.id
           AND cl.status = 'messaged' AND cl.attempts >= 1 AND cl.attempts < c.max_attempts
           AND cl.last_message_at <= $1::timestamptz - (c.follow_up_delay_days * interval '1 day')
       )
     ORDER BY c.created_at ASC LIMIT 50`,
    [now.toISOString()],
  );

  for (const row of rows) {
    result.campaignsChecked += 1;
    const schedule = row.schedule ?? {};
    const quietStart = Number.isInteger(schedule.quietHoursStart) ? schedule.quietHoursStart : 20;
    const quietEnd = Number.isInteger(schedule.quietHoursEnd) ? schedule.quietHoursEnd : 8;
    if (isQuietHour(hourInTimeZone(now, row.org_timezone), quietStart, quietEnd)) {
      result.skipped += 1;
      continue;
    }
    try {
      const outcome = await runCampaignFollowUps({
        organizationId: row.organization_id,
        campaignId: row.id,
        campaignName: row.name,
        channel: row.channel,
        tone: row.tone,
        objective: row.objective,
        followUpDelayDays: row.follow_up_delay_days,
        maxAttempts: row.max_attempts,
        stopConditions: Array.isArray(row.stop_conditions) ? row.stop_conditions : [],
      }, now);
      result.followUpsSent += outcome.sent;
      result.leadsStopped += outcome.stopped;
    } catch (error) {
      // One org's failure (e.g. plan limit reached) never blocks the others.
      result.skipped += 1;
      console.error(`Follow-up pass failed for campaign ${row.id}`, error);
    }
  }
  return result;
}

async function runCampaignFollowUps(
  campaign: {
    organizationId: string;
    campaignId: string;
    campaignName: string;
    channel: "sms" | "email";
    tone: string;
    objective: string | null;
    followUpDelayDays: number;
    maxAttempts: number;
    stopConditions: string[];
  },
  now: Date,
): Promise<{ sent: number; stopped: number }> {
  const pool = getPool();
  // Due leads — includes suppressed/opted-out ones so they can be stopped
  // instead of silently lingering.
  const { rows } = await pool.query(
    `SELECT f.*, cl.attempts
     FROM rescue_campaign_leads cl
     JOIN LATERAL (
       SELECT ${LEAD_FACT_COLUMNS} FROM rescue_leads
       WHERE id = cl.lead_id AND organization_id = cl.organization_id
     ) f ON true
     WHERE cl.organization_id = $1 AND cl.campaign_id = $2 AND cl.status = 'messaged'
       AND cl.attempts >= 1 AND cl.attempts < $3
       AND cl.last_message_at <= $4::timestamptz - ($5 * interval '1 day')
     ORDER BY cl.last_message_at ASC LIMIT $6`,
    [campaign.organizationId, campaign.campaignId, campaign.maxAttempts, now.toISOString(), campaign.followUpDelayDays, FOLLOW_UP_BATCH_LIMIT],
  );
  if (rows.length === 0) return { sent: 0, stopped: 0 };

  // Stop condition: appointment booked (any non-cancelled appointment).
  let apptLeadIds = new Set<string>();
  if (campaign.stopConditions.includes("appointment_booked")) {
    const appts = await pool.query(
      `SELECT DISTINCT lead_id FROM rescue_appointments
       WHERE organization_id = $1 AND status <> 'cancelled' AND lead_id = ANY($2::uuid[])`,
      [campaign.organizationId, rows.map((r) => r.id)],
    );
    apptLeadIds = new Set(appts.rows.map((r) => r.lead_id));
  }

  // Plan capacity gate: never over-send past the org's plan limit. Throws
  // (caught by the caller) when the whole batch would not fit — the campaign
  // simply waits for the next pass / next period.
  const sendMetric = campaign.channel === "sms" ? "sms_sent" : "emails_sent";
  const sendable = rows.filter((r) => !r.suppressed && r.consent_status !== "opted_out" && !apptLeadIds.has(r.id));
  if (sendable.length > 0) {
    await requireActionCapacity(campaign.organizationId, { [sendMetric]: sendable.length });
  }

  const branding = await getEffectiveBranding(campaign.organizationId);
  const orgName = (campaign.channel === "sms" ? branding?.smsSenderName : branding?.emailSenderName) ?? branding?.displayName ?? "Our team";

  let sent = 0;
  let stopped = 0;
  for (const row of rows) {
    const lead = mapLeadFacts(row);
    // Safety re-checks at send time — same rules as first-touch sends.
    if (lead.suppressed) {
      stopped += await stopCampaignLeads(campaign.organizationId, lead.id, "suppressed", campaign.campaignId);
      continue;
    }
    if (lead.consentStatus === "opted_out") {
      stopped += await stopCampaignLeads(campaign.organizationId, lead.id, "opt_out", campaign.campaignId);
      continue;
    }
    if (apptLeadIds.has(lead.id)) {
      stopped += await stopCampaignLeads(campaign.organizationId, lead.id, "appointment_booked", campaign.campaignId);
      continue;
    }
    const hasContact = campaign.channel === "sms" ? !!lead.phoneNormalized : !!lead.emailNormalized;
    if (!hasContact) continue;

    const attemptNumber = Number(row.attempts) + 1;
    const content = buildTemplateDraft(campaign.channel, lead, {
      orgName,
      tone: campaign.tone as CampaignTone,
      objective: campaign.objective ?? undefined,
      includeOptOutLanguage: true,
      attemptNumber,
      isFinalAttempt: attemptNumber >= campaign.maxAttempts,
    });
    await insertMessage({
      organizationId: campaign.organizationId,
      leadId: lead.id,
      campaignId: campaign.campaignId,
      direction: "outbound",
      channel: campaign.channel,
      subject: typeof content.subject === "string" ? content.subject : null,
      body: String(content.body ?? ""),
      status: "simulated",
      simulated: true,
      provider: "simulation",
      createdBy: null,
    });
    await markCampaignLeadMessaged(campaign.organizationId, campaign.campaignId, lead.id);
    await recordUsage(campaign.organizationId, sendMetric, 1).catch((error) => {
      console.error("Follow-up usage recording failed", campaign.organizationId, error);
    });
    sent += 1;

    // Stop condition: max attempts reached after this send.
    if (attemptNumber >= campaign.maxAttempts && campaign.stopConditions.includes("max_attempts")) {
      await pool.query(
        `UPDATE rescue_campaign_leads SET status = 'completed', stop_reason = 'max_attempts'
         WHERE organization_id = $1 AND campaign_id = $2 AND lead_id = $3 AND status = 'messaged'`,
        [campaign.organizationId, campaign.campaignId, lead.id],
      );
    }
  }

  if (sent > 0 || stopped > 0) {
    await logActivity({
      organizationId: campaign.organizationId,
      campaignId: campaign.campaignId,
      activityType: "messages_simulated",
      title: `${sent} follow-up message${sent === 1 ? "" : "s"} simulated for "${campaign.campaignName}"`,
      detail: `Automatic follow-up pass (every ${campaign.followUpDelayDays} day(s), max ${campaign.maxAttempts} attempts). Simulation Mode — no messages were actually sent.${stopped > 0 ? ` ${stopped} lead(s) stopped by safety checks.` : ""}`,
      metadata: { followUpsSent: sent, leadsStopped: stopped },
      actorUserId: null,
    });
  }
  return { sent, stopped };
}
