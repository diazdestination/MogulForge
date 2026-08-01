import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { isAppointmentStatus, isAppointmentType, listCalendarAdapters } from "@/lib/rescue-engage/calendar-adapters";
import { createAppointment, getLeadEngagement, listAppointments, logActivity, setLeadStage } from "@/lib/rescue-engage/store";
import { APPOINTMENT_WRITE_ROLES, ASSIGNED_ONLY_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Appointments list + calendar adapter status (manual is the only connected provider). */
export const GET = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "appointments");
  const restricted = ASSIGNED_ONLY_ROLES.includes(role);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  if (status && !isAppointmentStatus(status)) throw new ApiError(400, "Unknown status filter.");
  const appointments = await listAppointments(org.id, {
    assignedUserId: restricted ? user.id : undefined,
    status: status && isAppointmentStatus(status) ? status : undefined,
  });
  return NextResponse.json({ appointments, adapters: listCalendarAdapters(), scopedToAssigned: restricted });
});

/** Manual appointment booking. Sales reps can only book against their assigned leads. */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId, APPOINTMENT_WRITE_ROLES);
  await requireEntitlement(org.id, "appointments");
  const body = (await readJson(request)) as Record<string, unknown>;

  const leadId = typeof body.leadId === "string" ? body.leadId : "";
  if (!leadId) throw new ApiError(400, "leadId is required.");
  const engagement = await getLeadEngagement(org.id, leadId);
  if (!engagement) throw new ApiError(404, "Lead not found.");
  if (ASSIGNED_ONLY_ROLES.includes(role) && engagement.assignedUserId !== user.id) {
    throw new ApiError(403, "Sales reps can only book appointments for their assigned leads.");
  }

  const appointmentType = typeof body.appointmentType === "string" && isAppointmentType(body.appointmentType) ? body.appointmentType : "estimate";
  const scheduledStart = typeof body.scheduledStart === "string" ? body.scheduledStart : "";
  if (!scheduledStart || Number.isNaN(Date.parse(scheduledStart))) throw new ApiError(400, "scheduledStart must be a valid date/time.");
  const scheduledEnd = typeof body.scheduledEnd === "string" && !Number.isNaN(Date.parse(body.scheduledEnd)) ? body.scheduledEnd : null;

  const appointment = await createAppointment({
    organizationId: org.id,
    leadId,
    assignedUserId: typeof body.assignedUserId === "string" && body.assignedUserId !== "" ? body.assignedUserId : engagement.assignedUserId,
    appointmentType,
    scheduledStart,
    scheduledEnd,
    timezone: typeof body.timezone === "string" ? body.timezone.slice(0, 60) : null,
    address: typeof body.address === "string" ? body.address.slice(0, 300) : null,
    projectDetails: typeof body.projectDetails === "string" ? body.projectDetails.slice(0, 1000) : null,
    notes: typeof body.notes === "string" ? body.notes.slice(0, 1000) : null,
    createdBy: user.id,
  });
  if (!appointment) throw new ApiError(500, "Appointment could not be created.");

  // Booking an appointment is pipeline progress — move the lead forward unless it's already further along.
  if (["imported", "cleaned", "analyzed", "approved", "contacted", "replied", "qualified"].includes(engagement.pipelineStage)) {
    await setLeadStage(org.id, leadId, "appointment_booked");
  }
  await logActivity({
    organizationId: org.id,
    leadId,
    activityType: "appointment_booked",
    title: `Appointment booked (${appointmentType})`,
    detail: `Scheduled for ${scheduledStart}`,
    actorUserId: user.id,
  });
  return NextResponse.json({ appointment }, { status: 201 });
});
