import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { isAppointmentStatus } from "@/lib/rescue-engage/calendar-adapters";
import { getAppointment, logActivity, updateAppointment } from "@/lib/rescue-engage/store";
import { pushAppointmentUpdateToCalendar } from "@/lib/calendar/sync";
import { APPOINTMENT_WRITE_ROLES, ASSIGNED_ONLY_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; appointmentId: string }> };

/** Appointment status/schedule management (confirm, reschedule, complete, cancel, no-show). */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId, appointmentId } = await params;
  const { org, role, user } = await requireMember(orgId, APPOINTMENT_WRITE_ROLES);
  await requireEntitlement(org.id, "appointments");
  const existing = await getAppointment(org.id, appointmentId);
  if (!existing) throw new ApiError(404, "Appointment not found.");
  if (ASSIGNED_ONLY_ROLES.includes(role) && existing.assignedUserId !== user.id) {
    throw new ApiError(403, "Sales reps can only manage their own appointments.");
  }

  const body = (await readJson(request)) as Record<string, unknown>;
  const patch: Parameters<typeof updateAppointment>[2] = {};
  if (typeof body.status === "string") {
    if (!isAppointmentStatus(body.status)) throw new ApiError(400, "Unknown appointment status.");
    patch.status = body.status;
  }
  if (typeof body.scheduledStart === "string") {
    if (Number.isNaN(Date.parse(body.scheduledStart))) throw new ApiError(400, "scheduledStart must be a valid date/time.");
    patch.scheduledStart = body.scheduledStart;
    // A moved time without an explicit status is a reschedule.
    if (patch.status === undefined && existing.status !== "completed" && existing.status !== "cancelled") patch.status = "rescheduled";
  }
  if (typeof body.notes === "string") patch.notes = body.notes.slice(0, 1000);
  if (typeof body.address === "string") patch.address = body.address.slice(0, 300);
  if (body.assignedUserId === null || typeof body.assignedUserId === "string") patch.assignedUserId = body.assignedUserId as string | null;
  if (Object.keys(patch).length === 0) throw new ApiError(400, "Nothing to update.");

  const appointment = await updateAppointment(org.id, appointmentId, patch);
  if (!appointment) throw new ApiError(404, "Appointment not found.");
  if (patch.status && patch.status !== existing.status) {
    await logActivity({
      organizationId: org.id,
      leadId: existing.leadId,
      activityType: "appointment_updated",
      title: `Appointment ${patch.status}`,
      actorUserId: user.id,
    });
  }
  // Mirror schedule/status changes to the backing calendar event. Best-effort.
  if (patch.status !== undefined || patch.scheduledStart !== undefined) {
    await pushAppointmentUpdateToCalendar(org.id, appointmentId);
  }
  return NextResponse.json({ appointment });
});
