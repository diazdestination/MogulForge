import "server-only";
import { getPool } from "../db";
import { generateFirstTouchDraft, SuppressedLeadError } from "../rescue-analysis/messages.ts";
import { mapLeadFacts, LEAD_FACT_COLUMNS } from "../rescue-analysis/store";
import { hourInTimeZone, isWithinQuietHours, type CampaignTone } from "./campaign-schema.ts";
import { getProviderStatus, providerName, sendLiveMessage, ProviderSendError } from "./providers.ts";
import { computeAudience } from "./eligibility.ts";
import { interpolateBookingLink, publicBaseUrl, resolveBookingLink } from "./booking-link.ts";
import { getOrgSettings } from "../org-settings";
import {
  enrollCampaignLeads,
  getCampaign,
  insertMessage,
  logActivity,
  markCampaignLeadMessaged,
  markMessageSendOutcome,
  setCampaignStatus,
  type Campaign,
} from "./store.ts";

/**
 * Campaign activation + the simulation send engine.
 *
 * Hard guarantees:
 * - Live mode requires a connected provider (Twilio for SMS, a dedicated
 *   Resend outreach sender for email). Without credentials any live request is
 *   rejected with an explicit error — never silently downgraded after the human
 *   confirmed "live". Simulation Mode remains the default.
 * - Live activation is refused during the campaign's quiet hours, and live SMS
 *   sends skip leads without express/implied consent.
 * - Simulated sends are written with status 'simulated' and simulated=true.
 *   A DB CHECK constraint (rescue_messages_simulation_honesty) makes it
 *   impossible to record a simulated outbound message as sent/delivered.
 * - Eligibility is recomputed at activation with the same classifier as the
 *   preview: suppressed and opted-out contacts can never be enrolled.
 */

export class ActivationError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

const SEND_BATCH_LIMIT = 500;

export type ActivationResult = {
  campaign: Campaign;
  enrolled: number;
  simulatedSends: number;
  liveSends: number;
  failedSends: number;
  skippedNoContact: number;
  skippedNoConsent: number;
  accounting: Awaited<ReturnType<typeof computeAudience>>["accounting"];
};

export async function activateCampaign(input: {
  organizationId: string;
  campaignId: string;
  requestedMode: "simulation" | "live";
  confirmed: boolean;
  orgName: string;
  actorUserId: string | null;
}): Promise<ActivationResult> {
  const campaign = await getCampaign(input.organizationId, input.campaignId);
  if (!campaign) throw new ActivationError("Campaign not found.", 404);
  if (campaign.status !== "draft" && campaign.status !== "paused") {
    throw new ActivationError(`Campaign is ${campaign.status} — only draft or paused campaigns can be activated.`);
  }
  if (!input.confirmed) {
    throw new ActivationError("Activation requires explicit confirmation. Review the audience preview, then confirm.", 400);
  }
  let mode = input.requestedMode;
  if (campaign.approvalMode === "simulation_only" && mode === "live") {
    throw new ActivationError("This campaign is configured as simulation-only. Live activation is not allowed.");
  }
  if (mode === "live" && !getProviderStatus(campaign.channel).connected) {
    throw new ActivationError(
      `No ${campaign.channel === "sms" ? "SMS" : "email"} provider is connected, so live sending is unavailable. Activate in Simulation Mode instead — no messages will be sent.`,
    );
  }
  if (mode === "live") {
    // Quiet hours are evaluated in the organization's configured time zone,
    // not the server's clock.
    const tzResult = await getPool().query(`SELECT timezone FROM organizations WHERE id = $1`, [input.organizationId]);
    const orgTimezone: string | null = tzResult.rows[0]?.timezone ?? null;
    if (isWithinQuietHours(campaign.schedule, hourInTimeZone(new Date(), orgTimezone))) {
      throw new ActivationError(
        `It is currently within this campaign's quiet hours (${campaign.schedule.quietHoursStart}:00–${campaign.schedule.quietHoursEnd}:00${orgTimezone ? ` ${orgTimezone}` : ""}), so live sends are blocked right now. Activate outside quiet hours, or adjust them in the campaign settings.`,
      );
    }
  }
  if (mode !== "live") mode = "simulation";

  const preview = await computeAudience(input.organizationId, campaign.id, campaign.channel, campaign.audience);
  const enrolled = await enrollCampaignLeads(input.organizationId, campaign.id, preview.eligibleLeadIds);
  const updated = await setCampaignStatus(input.organizationId, campaign.id, "active", {
    activatedBy: input.actorUserId,
    mode,
  });
  if (!updated) throw new ActivationError("Campaign could not be activated.", 500);

  await logActivity({
    organizationId: input.organizationId,
    campaignId: campaign.id,
    activityType: "campaign_activated",
    title: `Campaign "${campaign.name}" activated in ${mode === "simulation" ? "Simulation Mode" : "live mode"}`,
    detail: `${preview.accounting.eligible} eligible · ${preview.accounting.suppressed + preview.accounting.optedOut + preview.accounting.doNotContact} blocked by suppression/consent`,
    metadata: { mode, accounting: preview.accounting },
    actorUserId: input.actorUserId,
  });

  // First-touch send pass: one templated message per newly enrolled lead —
  // recorded as simulated, or actually sent through the provider in live mode.
  const sendResult = mode === "simulation"
    ? { ...(await runSimulatedSends(input.organizationId, updated, input.orgName, input.actorUserId)), liveSends: 0, failedSends: 0, skippedNoConsent: 0 }
    : { ...(await runLiveSends(input.organizationId, updated, input.orgName, input.actorUserId)), simulatedSends: 0 };

  return {
    campaign: updated,
    enrolled,
    simulatedSends: sendResult.simulatedSends,
    liveSends: sendResult.liveSends,
    failedSends: sendResult.failedSends,
    skippedNoContact: sendResult.skippedNoContact,
    skippedNoConsent: sendResult.skippedNoConsent,
    accounting: preview.accounting,
  };
}

/**
 * Live first-touch send pass. Per lead, at send time:
 * - suppression/opt-out is re-checked by the enrollment query;
 * - live SMS additionally requires express or implied consent (leads with
 *   consent 'unknown' are skipped and left enrolled — never texted blind);
 * - the message row is written as queued (simulated=false) BEFORE the provider
 *   call, then honestly marked sent (with the provider's message id) or failed.
 */
export async function runLiveSends(
  organizationId: string,
  campaign: Campaign,
  orgName: string,
  actorUserId: string | null,
): Promise<{ liveSends: number; failedSends: number; skippedNoContact: number; skippedNoConsent: number }> {
  const { rows } = await getPool().query(
    `SELECT ${LEAD_FACT_COLUMNS} FROM rescue_leads
     WHERE organization_id = $1 AND suppressed = false AND consent_status <> 'opted_out'
       AND id IN (
         SELECT lead_id FROM rescue_campaign_leads
         WHERE organization_id = $1 AND campaign_id = $2 AND status = 'enrolled'
       )
     LIMIT $3`,
    [organizationId, campaign.id, SEND_BATCH_LIMIT],
  );
  const provider = providerName(campaign.channel);
  const statusCallbackUrl = campaign.channel === "sms" ? twilioStatusCallbackUrl() : null;
  const settings = await getOrgSettings(organizationId);
  const baseUrl = publicBaseUrl();
  let liveSends = 0;
  let failedSends = 0;
  let skippedNoContact = 0;
  let skippedNoConsent = 0;
  for (const row of rows) {
    const lead = mapLeadFacts(row);
    const to = campaign.channel === "sms" ? lead.phoneNormalized : lead.emailNormalized;
    if (!to) {
      skippedNoContact += 1;
      continue;
    }
    if (campaign.channel === "sms" && lead.consentStatus !== "express" && lead.consentStatus !== "implied") {
      skippedNoConsent += 1;
      continue;
    }
    // Per-lead booking URL: the /book/<token> link is minted with this lead's
    // id so a booking is attributable, falling back to the org's saved
    // default booking link / Calendly URL. See booking-link.ts.
    const bookingLink = resolveBookingLink({
      organizationId,
      leadId: lead.id,
      campaignId: campaign.id,
      campaignBookingLink: campaign.bookingLink,
      defaultBookingLink: settings.messaging.defaultBookingLink,
      calendlyUrl: settings.calendar.calendlyUrl,
      baseUrl,
    });
    // First-touch content: AI-written (fact-only prompt, opt-out enforced on
    // output) when OPENAI_API_KEY is configured, deterministic template
    // otherwise or on any AI failure. Suppression is re-checked inside.
    let content: Record<string, unknown>;
    try {
      ({ content } = await generateFirstTouchDraft(lead, {
        channel: campaign.channel,
        tone: campaign.tone as CampaignTone,
        objective: campaign.objective ?? undefined,
        bookingLink: campaign.bookingLink?.trim() ? bookingLink : undefined,
      }, orgName));
    } catch (error) {
      if (error instanceof SuppressedLeadError) continue; // suppressed since enrollment — never message
      throw error;
    }
    const rawSubject = typeof content.subject === "string" ? content.subject : null;
    const subject = rawSubject === null ? null : interpolateBookingLink(rawSubject, bookingLink);
    const body = interpolateBookingLink(String(content.body ?? ""), bookingLink);
    const message = await insertMessage({
      organizationId,
      leadId: lead.id,
      campaignId: campaign.id,
      direction: "outbound",
      channel: campaign.channel,
      subject,
      body,
      status: "queued",
      simulated: false,
      provider,
      createdBy: actorUserId,
    });
    try {
      const result = await sendLiveMessage({ channel: campaign.channel, to, subject, body, statusCallbackUrl });
      await markMessageSendOutcome(organizationId, message.id, { status: "sent", providerMessageId: result.providerMessageId });
      await markCampaignLeadMessaged(organizationId, campaign.id, lead.id);
      await getPool().query(
        `UPDATE rescue_leads SET pipeline_stage = 'contacted', stage_changed_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND pipeline_stage IN ('imported', 'cleaned', 'analyzed', 'approved')`,
        [organizationId, lead.id],
      );
      liveSends += 1;
    } catch (error) {
      await markMessageSendOutcome(organizationId, message.id, { status: "failed" });
      failedSends += 1;
      const detail = error instanceof ProviderSendError ? error.message : "Unexpected provider error.";
      await logActivity({
        organizationId,
        campaignId: campaign.id,
        leadId: lead.id,
        activityType: "message_send_failed",
        title: `Live ${campaign.channel === "sms" ? "SMS" : "email"} send failed`,
        detail: detail.slice(0, 300),
        metadata: { messageId: message.id, provider },
        actorUserId,
      });
    }
  }
  if (liveSends > 0 || failedSends > 0) {
    await logActivity({
      organizationId,
      campaignId: campaign.id,
      activityType: "messages_sent",
      title: `${liveSends} live message${liveSends === 1 ? "" : "s"} sent for "${campaign.name}"${failedSends > 0 ? ` (${failedSends} failed)` : ""}`,
      detail: `Live mode via ${provider === "twilio" ? "Twilio" : "Resend"}.`,
      metadata: { liveSends, failedSends, skippedNoContact, skippedNoConsent },
      actorUserId,
    });
  }
  return { liveSends, failedSends, skippedNoContact, skippedNoConsent };
}

/** Absolute delivery-status callback URL for Twilio, when a public base URL is known. */
function twilioStatusCallbackUrl(): string | null {
  const base = process.env.PUBLIC_BASE_URL?.trim() || (process.env.REPLIT_DOMAINS ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}` : null);
  return base ? `${base.replace(/\/$/, "")}/api/webhooks/twilio/status` : null;
}

/**
 * Records a simulated outbound message for every enrolled lead that has not
 * been messaged yet. Re-checks suppression per lead at send time — a lead
 * suppressed between enrollment and sending is skipped and stopped.
 */
export async function runSimulatedSends(
  organizationId: string,
  campaign: Campaign,
  orgName: string,
  actorUserId: string | null,
): Promise<{ simulatedSends: number; skippedNoContact: number }> {
  const { rows } = await getPool().query(
    `SELECT ${LEAD_FACT_COLUMNS} FROM rescue_leads
     WHERE organization_id = $1 AND suppressed = false AND consent_status <> 'opted_out'
       AND id IN (
         SELECT lead_id FROM rescue_campaign_leads
         WHERE organization_id = $1 AND campaign_id = $2 AND status = 'enrolled'
       )
     LIMIT $3`,
    [organizationId, campaign.id, SEND_BATCH_LIMIT],
  );
  const settings = await getOrgSettings(organizationId);
  const baseUrl = publicBaseUrl();
  let simulatedSends = 0;
  let skippedNoContact = 0;
  for (const row of rows) {
    const lead = mapLeadFacts(row);
    const hasContact = campaign.channel === "sms" ? !!lead.phoneNormalized : !!lead.emailNormalized;
    if (!hasContact) {
      skippedNoContact += 1;
      continue;
    }
    const bookingLink = resolveBookingLink({
      organizationId,
      leadId: lead.id,
      campaignId: campaign.id,
      campaignBookingLink: campaign.bookingLink,
      defaultBookingLink: settings.messaging.defaultBookingLink,
      calendlyUrl: settings.calendar.calendlyUrl,
      baseUrl,
    });
    // Same AI-first drafting as live sends, so Simulation Mode shows exactly
    // the kind of message a live activation would produce.
    let content: Record<string, unknown>;
    try {
      ({ content } = await generateFirstTouchDraft(lead, {
        channel: campaign.channel,
        tone: campaign.tone as CampaignTone,
        objective: campaign.objective ?? undefined,
        bookingLink: campaign.bookingLink?.trim() ? bookingLink : undefined,
      }, orgName));
    } catch (error) {
      if (error instanceof SuppressedLeadError) continue; // suppressed since enrollment — never message
      throw error;
    }
    const rawSubject = typeof content.subject === "string" ? content.subject : null;
    await insertMessage({
      organizationId,
      leadId: lead.id,
      campaignId: campaign.id,
      direction: "outbound",
      channel: campaign.channel,
      subject: rawSubject === null ? null : interpolateBookingLink(rawSubject, bookingLink),
      body: interpolateBookingLink(String(content.body ?? ""), bookingLink),
      status: "simulated",
      simulated: true,
      provider: "simulation",
      createdBy: actorUserId,
    });
    await markCampaignLeadMessaged(organizationId, campaign.id, lead.id);
    await getPool().query(
      `UPDATE rescue_leads SET pipeline_stage = 'contacted', stage_changed_at = now(), updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND pipeline_stage IN ('imported', 'cleaned', 'analyzed', 'approved')`,
      [organizationId, lead.id],
    );
    simulatedSends += 1;
  }
  if (simulatedSends > 0) {
    await logActivity({
      organizationId,
      campaignId: campaign.id,
      activityType: "messages_simulated",
      title: `${simulatedSends} message${simulatedSends === 1 ? "" : "s"} simulated for "${campaign.name}"`,
      detail: "Simulation Mode — no messages were actually sent.",
      metadata: { simulatedSends, skippedNoContact },
      actorUserId,
    });
  }
  return { simulatedSends, skippedNoContact };
}
