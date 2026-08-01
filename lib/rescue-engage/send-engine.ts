import "server-only";
import { getPool } from "../db";
import { buildTemplateDraft } from "../rescue-analysis/message-content.ts";
import { mapLeadFacts, LEAD_FACT_COLUMNS } from "../rescue-analysis/store";
import type { CampaignTone } from "./campaign-schema.ts";
import { liveSendingAvailable } from "./providers.ts";
import { computeAudience } from "./eligibility.ts";
import {
  enrollCampaignLeads,
  getCampaign,
  insertMessage,
  logActivity,
  markCampaignLeadMessaged,
  setCampaignStatus,
  type Campaign,
} from "./store.ts";

/**
 * Campaign activation + the simulation send engine.
 *
 * Hard guarantees:
 * - Live mode requires a connected provider; none exist, so any live request is
 *   rejected with an explicit error — never silently downgraded after the human
 *   confirmed "live".
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
  skippedNoContact: number;
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
  if (mode === "live" && !liveSendingAvailable(campaign.channel)) {
    throw new ActivationError(
      `No ${campaign.channel === "sms" ? "SMS" : "email"} provider is connected, so live sending is unavailable. Activate in Simulation Mode instead — no messages will be sent.`,
    );
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

  // Simulation send pass: one templated first-touch message per newly enrolled lead.
  const sendResult = mode === "simulation"
    ? await runSimulatedSends(input.organizationId, updated, input.orgName, input.actorUserId)
    : { simulatedSends: 0, skippedNoContact: 0 }; // unreachable today — no live provider exists

  return {
    campaign: updated,
    enrolled,
    simulatedSends: sendResult.simulatedSends,
    skippedNoContact: sendResult.skippedNoContact,
    accounting: preview.accounting,
  };
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
  let simulatedSends = 0;
  let skippedNoContact = 0;
  for (const row of rows) {
    const lead = mapLeadFacts(row);
    const hasContact = campaign.channel === "sms" ? !!lead.phoneNormalized : !!lead.emailNormalized;
    if (!hasContact) {
      skippedNoContact += 1;
      continue;
    }
    const content = buildTemplateDraft(campaign.channel, lead, {
      orgName,
      tone: campaign.tone as CampaignTone,
      objective: campaign.objective ?? undefined,
      includeOptOutLanguage: true,
    });
    await insertMessage({
      organizationId,
      leadId: lead.id,
      campaignId: campaign.id,
      direction: "outbound",
      channel: campaign.channel,
      subject: typeof content.subject === "string" ? content.subject : null,
      body: String(content.body ?? ""),
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
