import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { ActivationError, activateCampaign } from "@/lib/rescue-engage/send-engine";
import { computeAudience } from "@/lib/rescue-engage/eligibility";
import { getCampaign } from "@/lib/rescue-engage/store";
import { CAMPAIGN_MANAGE_ROLES } from "@/lib/roles";
import { recordUsageInBackground, requireActionCapacity } from "@/lib/usage";
import { resolveOrgBranding } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; campaignId: string }> };

/**
 * Campaign activation. Requires explicit confirmation from a human
 * (`confirm: true`). Live mode is refused while no provider is connected —
 * the send engine enforces this and the DB constraint backs it up.
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, campaignId } = await params;
  const { org, user } = await requireMember(orgId, CAMPAIGN_MANAGE_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const campaign = await getCampaign(org.id, campaignId);
  if (!campaign) throw new ApiError(404, "Campaign not found.");
  await requireEntitlement(org.id, campaign.channel === "sms" ? "sms_campaigns" : "email_campaigns");

  // Usage gate: campaign sends count against the channel's plan limit
  // (simulated sends are metered too). The gate is quantity-aware — it checks
  // capacity for the campaign's full projected audience, so a single
  // activation can never blow past the plan limit. Opt-out/suppression
  // handling inside the send engine always runs — it is never routed through
  // this gate.
  const sendMetric = campaign.channel === "sms" ? "sms_sent" : "emails_sent";
  const projected = await computeAudience(org.id, campaign.id, campaign.channel, campaign.audience);
  await requireActionCapacity(org.id, projected.accounting.eligible > 0 ? { [sendMetric]: projected.accounting.eligible } : {});

  // White-label branding: sends go out under the org's configured sender name.
  const branding = await resolveOrgBranding(org);

  const body = (await readJson(request)) as { mode?: string; confirm?: boolean };
  const mode = body.mode === "live" ? "live" : "simulation";
  try {
    const result = await activateCampaign({
      organizationId: org.id,
      campaignId,
      requestedMode: mode,
      confirmed: body.confirm === true,
      orgName: campaign.channel === "sms" ? branding.smsSenderName : branding.emailSenderName,
      actorUserId: user.id,
    });
    if (result.simulatedSends > 0) recordUsageInBackground(org.id, sendMetric, result.simulatedSends);
    return NextResponse.json({
      campaign: result.campaign,
      enrolled: result.enrolled,
      simulatedSends: result.simulatedSends,
      skippedNoContact: result.skippedNoContact,
      accounting: result.accounting,
    });
  } catch (error) {
    if (error instanceof ActivationError) throw new ApiError(error.status, error.message);
    throw error;
  }
});
