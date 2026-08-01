import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { ActivationError, activateCampaign } from "@/lib/rescue-engage/send-engine";
import { getCampaign } from "@/lib/rescue-engage/store";
import { CAMPAIGN_MANAGE_ROLES } from "@/lib/roles";

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

  const body = (await readJson(request)) as { mode?: string; confirm?: boolean };
  const mode = body.mode === "live" ? "live" : "simulation";
  try {
    const result = await activateCampaign({
      organizationId: org.id,
      campaignId,
      requestedMode: mode,
      confirmed: body.confirm === true,
      orgName: org.name,
      actorUserId: user.id,
    });
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
