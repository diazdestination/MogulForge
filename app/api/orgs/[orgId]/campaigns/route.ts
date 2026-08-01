import { NextResponse } from "next/server";
import { guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { parseCampaignInput } from "@/lib/rescue-engage/campaign-schema";
import { CAMPAIGN_TEMPLATES } from "@/lib/rescue-engage/campaign-templates";
import { getProviderStatus } from "@/lib/rescue-engage/providers";
import { createCampaign, listCampaigns, logActivity } from "@/lib/rescue-engage/store";
import { ASSIGNED_ONLY_ROLES, CAMPAIGN_MANAGE_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * Campaign list with per-campaign stats, plus templates and provider status
 * for the builder. Assigned-only roles (sales reps) only see campaigns that
 * include their assigned leads, with stats restricted to those leads.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "revenue_rescue");
  const restricted = ASSIGNED_ONLY_ROLES.includes(role);
  const campaigns = await listCampaigns(org.id, { assignedUserId: restricted ? user.id : undefined });
  return NextResponse.json({
    campaigns,
    templates: CAMPAIGN_TEMPLATES,
    providers: { sms: getProviderStatus("sms"), email: getProviderStatus("email") },
    canManage: CAMPAIGN_MANAGE_ROLES.includes(role),
    scopedToAssigned: restricted,
  });
});

/** Creates a draft campaign. Owner/admin/sales-manager only; channel entitlement enforced. */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, user } = await requireMember(orgId, CAMPAIGN_MANAGE_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = (await readJson(request)) as Record<string, unknown>;
  const input = parseCampaignInput(body); // throws with a clear message on invalid input
  await requireEntitlement(org.id, input.channel === "sms" ? "sms_campaigns" : "email_campaigns");
  const campaign = await createCampaign(org.id, user.id, input);
  await logActivity({
    organizationId: org.id,
    campaignId: campaign.id,
    activityType: "campaign_created",
    title: `Campaign "${campaign.name}" created (draft)`,
    actorUserId: user.id,
  });
  return NextResponse.json({ campaign }, { status: 201 });
});
