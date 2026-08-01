import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { parseCampaignInput } from "@/lib/rescue-engage/campaign-schema";
import { getProviderStatus } from "@/lib/rescue-engage/providers";
import {
  deleteDraftCampaign,
  getCampaign,
  getCampaignStats,
  listCampaignLeads,
  logActivity,
  setCampaignStatus,
  updateCampaign,
} from "@/lib/rescue-engage/store";
import { ASSIGNED_ONLY_ROLES, CAMPAIGN_MANAGE_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; campaignId: string }> };

/**
 * Campaign detail. Assigned-only roles (sales reps) only see campaigns that
 * include their assigned leads; stats and the enrolled-lead list are
 * restricted to those leads so campaigns can never be used to browse other
 * users' leads.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, campaignId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "revenue_rescue");
  const campaign = await getCampaign(org.id, campaignId);
  if (!campaign) throw new ApiError(404, "Campaign not found.");
  const restricted = ASSIGNED_ONLY_ROLES.includes(role);
  const scope = { assignedUserId: restricted ? user.id : undefined };
  const [stats, leads] = await Promise.all([
    getCampaignStats(org.id, campaignId, scope),
    listCampaignLeads(org.id, campaignId, 100, scope),
  ]);
  // A rep with no assigned leads in this campaign has no business seeing it.
  if (restricted && leads.length === 0) throw new ApiError(404, "Campaign not found.");
  return NextResponse.json({
    campaign,
    stats,
    leads,
    provider: getProviderStatus(campaign.channel),
    canManage: CAMPAIGN_MANAGE_ROLES.includes(role),
    scopedToAssigned: restricted,
  });
});

/**
 * Updates a draft/paused campaign (`action: "update"`) or transitions status
 * (`action: "pause" | "complete" | "archive"`). Reactivation goes through the
 * /activate route so it always passes the confirmation + eligibility gate.
 */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, campaignId } = await params;
  const { org, user } = await requireMember(orgId, CAMPAIGN_MANAGE_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = (await readJson(request)) as Record<string, unknown>;
  const existing = await getCampaign(org.id, campaignId);
  if (!existing) throw new ApiError(404, "Campaign not found.");

  if (body.action === "update") {
    const input = parseCampaignInput(body.input as Record<string, unknown>);
    await requireEntitlement(org.id, input.channel === "sms" ? "sms_campaigns" : "email_campaigns");
    const campaign = await updateCampaign(org.id, campaignId, input);
    if (!campaign) throw new ApiError(409, "Only draft or paused campaigns can be edited.");
    return NextResponse.json({ campaign });
  }

  const transitions: Record<string, { from: string[]; to: "paused" | "completed" | "archived" }> = {
    pause: { from: ["active"], to: "paused" },
    complete: { from: ["active", "paused"], to: "completed" },
    archive: { from: ["draft", "paused", "completed"], to: "archived" },
  };
  const transition = transitions[String(body.action)];
  if (!transition) throw new ApiError(400, "Unknown action.");
  if (!transition.from.includes(existing.status)) {
    throw new ApiError(409, `Cannot ${String(body.action)} a ${existing.status} campaign.`);
  }
  const campaign = await setCampaignStatus(org.id, campaignId, transition.to);
  await logActivity({
    organizationId: org.id,
    campaignId,
    activityType: `campaign_${transition.to}`,
    title: `Campaign "${existing.name}" ${transition.to}`,
    actorUserId: user.id,
  });
  return NextResponse.json({ campaign });
});

export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, campaignId } = await params;
  const { org } = await requireMember(orgId, CAMPAIGN_MANAGE_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const deleted = await deleteDraftCampaign(org.id, campaignId);
  if (!deleted) throw new ApiError(409, "Only draft campaigns can be deleted. Archive it instead.");
  return NextResponse.json({ ok: true });
});
