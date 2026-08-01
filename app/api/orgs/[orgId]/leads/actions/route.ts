import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { isPipelineStage, MANUAL_STAGES } from "@/lib/rescue-engage/pipeline";
import {
  assignLead,
  enrollCampaignLeads,
  filterLeadsAssignedTo,
  getCampaign,
  logActivity,
  setLeadStage,
  suppressLeadContact,
} from "@/lib/rescue-engage/store";
import { ASSIGNED_ONLY_ROLES, CAMPAIGN_MANAGE_ROLES, LEAD_ACTION_ROLES } from "@/lib/roles";
import { listMembers } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

const MAX_BULK = 200;

/**
 * Bulk lead actions: assign, stage, suppress, add_to_campaign.
 * Sales reps are limited to leads assigned to them (silently filtered — the
 * response reports how many were actually affected).
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId, LEAD_ACTION_ROLES);
  await requireEntitlement(org.id, "lead_import");

  const body = (await readJson(request)) as Record<string, unknown>;
  const rawIds = Array.isArray(body.leadIds) ? body.leadIds.filter((id): id is string => typeof id === "string") : [];
  if (rawIds.length === 0) throw new ApiError(400, "leadIds is required.");
  if (rawIds.length > MAX_BULK) throw new ApiError(400, `At most ${MAX_BULK} leads per bulk action.`);
  const leadIds = ASSIGNED_ONLY_ROLES.includes(role) ? await filterLeadsAssignedTo(org.id, rawIds, user.id) : rawIds;
  if (leadIds.length === 0) throw new ApiError(403, "None of the selected leads are assigned to you.");

  switch (body.action) {
    case "assign": {
      if (!CAMPAIGN_MANAGE_ROLES.includes(role)) throw new ApiError(403, "Only managers can assign leads.");
      const userId = body.userId === null || body.userId === "" ? null : String(body.userId);
      if (userId) {
        const members = await listMembers(org.id);
        if (!members.some((m) => m.userId === userId)) throw new ApiError(400, "That user is not a member of this organization.");
      }
      let affected = 0;
      for (const leadId of leadIds) if (await assignLead(org.id, leadId, userId)) affected += 1;
      await logActivity({
        organizationId: org.id, activityType: "bulk_assign",
        title: `${affected} lead${affected === 1 ? "" : "s"} ${userId ? "assigned" : "unassigned"}`, actorUserId: user.id,
      });
      return NextResponse.json({ affected });
    }
    case "stage": {
      const stage = String(body.stage ?? "");
      if (!isPipelineStage(stage) || !MANUAL_STAGES.includes(stage)) throw new ApiError(400, "That stage cannot be set manually.");
      let affected = 0;
      for (const leadId of leadIds) if (await setLeadStage(org.id, leadId, stage)) affected += 1;
      await logActivity({
        organizationId: org.id, activityType: "bulk_stage",
        title: `${affected} lead${affected === 1 ? "" : "s"} moved to ${stage}`, actorUserId: user.id,
      });
      return NextResponse.json({ affected });
    }
    case "suppress": {
      const reason = typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim().slice(0, 200) : "Suppressed by team (bulk)";
      for (const leadId of leadIds) await suppressLeadContact(org.id, leadId, reason, { optOut: false });
      await logActivity({
        organizationId: org.id, activityType: "bulk_suppress",
        title: `${leadIds.length} contact${leadIds.length === 1 ? "" : "s"} suppressed`, detail: reason, actorUserId: user.id,
      });
      return NextResponse.json({ affected: leadIds.length });
    }
    case "add_to_campaign": {
      if (!CAMPAIGN_MANAGE_ROLES.includes(role)) throw new ApiError(403, "Only managers can add leads to campaigns.");
      const campaignId = String(body.campaignId ?? "");
      const campaign = await getCampaign(org.id, campaignId);
      if (!campaign) throw new ApiError(404, "Campaign not found.");
      if (campaign.status === "archived" || campaign.status === "completed") {
        throw new ApiError(409, "Cannot add leads to a completed or archived campaign.");
      }
      // Suppressed/opted-out leads are excluded here too — same rule as the eligibility engine.
      const { computeAudience } = await import("@/lib/rescue-engage/eligibility");
      const preview = await computeAudience(org.id, campaignId, campaign.channel, {
        categories: [], minScore: null, projectTypes: [], sources: [], importId: null,
      });
      const eligibleSet = new Set(preview.eligibleLeadIds);
      const toEnroll = leadIds.filter((id) => eligibleSet.has(id));
      const enrolled = await enrollCampaignLeads(org.id, campaignId, toEnroll);
      await logActivity({
        organizationId: org.id, campaignId, activityType: "bulk_enroll",
        title: `${enrolled} lead${enrolled === 1 ? "" : "s"} added to "${campaign.name}"`, actorUserId: user.id,
      });
      return NextResponse.json({ affected: enrolled, skipped: leadIds.length - enrolled });
    }
    default:
      throw new ApiError(400, "Unknown action.");
  }
});
