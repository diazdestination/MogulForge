import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { buildSampleMessages, computeAudience } from "@/lib/rescue-engage/eligibility";
import { getProviderStatus } from "@/lib/rescue-engage/providers";
import { getCampaign } from "@/lib/rescue-engage/store";
import { publicBaseUrl, resolveBookingLink } from "@/lib/rescue-engage/booking-link";
import { getOrgSettings } from "@/lib/org-settings";

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
  // Mirror the send engine: sample messages include the resolved per-lead
  // booking link when the campaign has a booking link configured.
  const settings = await getOrgSettings(org.id);
  const baseUrl = publicBaseUrl();
  const samples = buildSampleMessages(preview.sampleLeads, {
    channel: campaign.channel,
    tone: campaign.tone as "professional" | "friendly" | "urgent",
    objective: campaign.objective,
    orgName: org.name,
    resolveBookingLinkFor: campaign.bookingLink?.trim()
      ? (leadId) =>
          resolveBookingLink({
            organizationId: org.id,
            leadId,
            campaignBookingLink: campaign.bookingLink,
            defaultBookingLink: settings.messaging.defaultBookingLink,
            calendlyUrl: settings.calendar.calendlyUrl,
            baseUrl,
          })
      : undefined,
  });
  return NextResponse.json({
    accounting: preview.accounting,
    samples,
    provider: getProviderStatus(campaign.channel),
    estimatedSends: preview.accounting.eligible,
  });
});
