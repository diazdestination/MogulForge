import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { buildSampleMessages, computeAudience } from "@/lib/rescue-engage/eligibility";
import { getProviderStatus } from "@/lib/rescue-engage/providers";
import { getCampaign } from "@/lib/rescue-engage/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; campaignId: string }> };

/**
 * Pre-activation audience preview: eligible/excluded/suppressed/invalid
 * accounting plus sample messages built from stored lead facts. The exact same
 * classifier runs at activation, so what's shown here is what gets enrolled.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, campaignId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "revenue_rescue");
  const campaign = await getCampaign(org.id, campaignId);
  if (!campaign) throw new ApiError(404, "Campaign not found.");
  const preview = await computeAudience(org.id, campaign.id, campaign.channel, campaign.audience);
  const samples = buildSampleMessages(preview.sampleLeads, {
    channel: campaign.channel,
    tone: campaign.tone as "professional" | "friendly" | "urgent",
    objective: campaign.objective,
    orgName: org.name,
  });
  return NextResponse.json({
    accounting: preview.accounting,
    samples,
    provider: getProviderStatus(campaign.channel),
    estimatedSends: preview.accounting.eligible,
  });
});
