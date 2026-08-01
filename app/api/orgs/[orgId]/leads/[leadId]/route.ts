import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getLeadDetail, listMessageDrafts } from "@/lib/rescue-analysis/store";
import { isPipelineStage, MANUAL_STAGES } from "@/lib/rescue-engage/pipeline";
import {
  addLeadNote,
  assignLead,
  getLeadEngagement,
  listActivities,
  listAppointments,
  listLeadMessages,
  listTasks,
  logActivity,
  setLeadStage,
  suppressLeadContact,
} from "@/lib/rescue-engage/store";
import { ASSIGNED_ONLY_ROLES, CAMPAIGN_MANAGE_ROLES, LEAD_ACTION_ROLES } from "@/lib/roles";
import { listMembers } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; leadId: string }> };

/**
 * Full lead detail: contact/project facts, score explanation, drafts,
 * engagement (stage, assignment, campaigns), conversation, timeline, tasks,
 * and appointments. Sales reps can only open their assigned leads.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, leadId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "lead_import");
  const lead = await getLeadDetail(org.id, leadId);
  if (!lead) throw new ApiError(404, "Lead not found.");
  if (ASSIGNED_ONLY_ROLES.includes(role) && lead.assignedUserId !== user.id) {
    throw new ApiError(403, "Sales reps can only view their assigned leads.");
  }
  const [drafts, engagement, messages, activities, tasks, appointments, members] = await Promise.all([
    listMessageDrafts(org.id, leadId),
    getLeadEngagement(org.id, leadId),
    listLeadMessages(org.id, leadId),
    listActivities(org.id, { leadId, limit: 50 }),
    listTasks(org.id, { leadId, limit: 20 }),
    listAppointments(org.id, { limit: 20 }).then((all) => all.filter((a) => a.leadId === leadId)),
    listMembers(org.id),
  ]);
  return NextResponse.json({
    lead,
    drafts,
    engagement,
    messages,
    activities,
    tasks,
    appointments,
    members: members.map((m) => ({ userId: m.userId, name: m.name, role: m.role })),
    role,
  });
});

/**
 * Lead lifecycle actions: assign, set pipeline stage, suppress, add note.
 * All server-side role-checked; suppression is irreversible from this API.
 */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, leadId } = await params;
  const { org, role, user } = await requireMember(orgId, LEAD_ACTION_ROLES);
  await requireEntitlement(org.id, "lead_import");
  const engagement = await getLeadEngagement(org.id, leadId);
  if (!engagement) throw new ApiError(404, "Lead not found.");
  if (ASSIGNED_ONLY_ROLES.includes(role) && engagement.assignedUserId !== user.id) {
    throw new ApiError(403, "Sales reps can only act on their assigned leads.");
  }

  const body = (await readJson(request)) as Record<string, unknown>;
  switch (body.action) {
    case "assign": {
      // Assignment is a management action — reps cannot reassign their own leads.
      if (!CAMPAIGN_MANAGE_ROLES.includes(role)) throw new ApiError(403, "Only managers can assign leads.");
      const userId = body.userId === null || body.userId === "" ? null : String(body.userId);
      if (userId) {
        const members = await listMembers(org.id);
        if (!members.some((m) => m.userId === userId)) throw new ApiError(400, "That user is not a member of this organization.");
      }
      await assignLead(org.id, leadId, userId);
      await logActivity({
        organizationId: org.id, leadId, activityType: "lead_assigned",
        title: userId ? "Lead assigned" : "Lead unassigned", actorUserId: user.id,
      });
      return NextResponse.json({ ok: true });
    }
    case "stage": {
      const stage = String(body.stage ?? "");
      if (!isPipelineStage(stage) || !MANUAL_STAGES.includes(stage)) {
        throw new ApiError(400, "That stage cannot be set manually.");
      }
      const wonValueRaw = Number(body.wonValue);
      const moved = await setLeadStage(org.id, leadId, stage, {
        wonValue: stage === "won" && Number.isFinite(wonValueRaw) && wonValueRaw >= 0 ? wonValueRaw : null,
      });
      if (!moved) throw new ApiError(409, "Suppressed leads cannot change stage.");
      await logActivity({
        organizationId: org.id, leadId, activityType: "stage_changed",
        title: `Stage set to ${stage}`, actorUserId: user.id,
      });
      return NextResponse.json({ ok: true });
    }
    case "suppress": {
      const reason = typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim().slice(0, 200) : "Suppressed by team";
      await suppressLeadContact(org.id, leadId, reason, { optOut: body.optOut === true });
      await logActivity({
        organizationId: org.id, leadId, activityType: "contact_suppressed",
        title: "Contact suppressed — all automated outreach blocked", detail: reason, actorUserId: user.id,
      });
      return NextResponse.json({ ok: true });
    }
    case "note": {
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
      if (!note) throw new ApiError(400, "Note text is required.");
      await addLeadNote(org.id, leadId, note);
      await logActivity({
        organizationId: org.id, leadId, activityType: "note_added",
        title: "Note added", detail: note.slice(0, 200), actorUserId: user.id,
      });
      return NextResponse.json({ ok: true });
    }
    default:
      throw new ApiError(400, "Unknown action.");
  }
});
