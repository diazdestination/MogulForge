import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, PublicApiError, readV1Json } from "@/lib/public-api/http";
import { getCampaign, getCampaignStats, setCampaignStatus } from "@/lib/rescue-engage/store";
import { emitOrgEventInBackground } from "@/lib/webhooks/outgoing";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ campaignId: string }> };

/** GET /api/v1/campaigns/:id — campaign detail with stats. Scope: campaigns:read. */
export const GET = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "campaigns:read");
  const { campaignId } = await params;
  const campaign = await getCampaign(ctx.org.id, campaignId).catch(() => null);
  if (!campaign) throw new PublicApiError(404, "not_found", "Campaign not found.");
  const stats = await getCampaignStats(ctx.org.id, campaignId);
  return NextResponse.json({ data: { ...campaign, stats } }, { headers: ctx.rateHeaders });
});

/**
 * PATCH /api/v1/campaigns/:id — pause or resume a campaign. Scope: campaigns:write.
 * Activation of drafts is deliberately dashboard-only (it requires eligibility review).
 */
export const PATCH = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "campaigns:write");
  const { campaignId } = await params;
  const body = await readV1Json(request);
  const status = body.status;
  if (status !== "paused" && status !== "active") {
    throw new PublicApiError(422, "invalid_status", "status must be 'paused' or 'active' (pause/resume only via API).");
  }
  const campaign = await getCampaign(ctx.org.id, campaignId).catch(() => null);
  if (!campaign) throw new PublicApiError(404, "not_found", "Campaign not found.");
  if (campaign.status !== "active" && campaign.status !== "paused") {
    throw new PublicApiError(409, "invalid_transition", `Only active or paused campaigns can be toggled via API (current status: ${campaign.status}).`);
  }
  if (campaign.status === status) return NextResponse.json({ data: campaign }, { headers: ctx.rateHeaders });
  const updated = await setCampaignStatus(ctx.org.id, campaignId, status);
  emitOrgEventInBackground(ctx.org.id, "campaign.status_changed", { campaign_id: campaignId, status, source: "public_api" });
  return NextResponse.json({ data: updated }, { headers: ctx.rateHeaders });
});
