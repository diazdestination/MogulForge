import { buildAppointmentAlertEmail } from "@/lib/org-alerts-content";
import { sendOrgAlertInBackground } from "@/lib/org-alerts";
import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, listResponse, parsePagination, PublicApiError, readV1Json } from "@/lib/public-api/http";
import { withIdempotency } from "@/lib/public-api/idempotency";
import { isAppointmentStatus, isAppointmentType } from "@/lib/rescue-engage/calendar-adapters";
import { createAppointment, getLeadEngagement, listAppointments } from "@/lib/rescue-engage/store";
import { pushAppointmentToCalendar } from "@/lib/calendar/sync";
import { emitOrgEventInBackground } from "@/lib/webhooks/outgoing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/appointments — list appointments. Scope: appointments:read. */
export const GET = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "appointments:read");
  const url = new URL(request.url);
  const pagination = parsePagination(url);
  const status = url.searchParams.get("status") ?? undefined;
  if (status && !isAppointmentStatus(status)) throw new PublicApiError(400, "invalid_parameter", `Unknown appointment status: ${status}.`);
  const appointments = await listAppointments(ctx.org.id, {
    status: status && isAppointmentStatus(status) ? status : undefined,
    limit: 500,
  });
  const page = appointments.slice(pagination.offset, pagination.offset + pagination.limit);
  return listResponse(page, pagination, appointments.length, ctx.rateHeaders);
});

/** POST /api/v1/appointments — book an appointment. Scope: appointments:write. Supports Idempotency-Key. */
export const POST = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "appointments:write");
  const body = await readV1Json(request);
  return withIdempotency(ctx.org.id, "POST /v1/appointments", request, body, async () => {
    const leadId = typeof body.leadId === "string" ? body.leadId : typeof body.lead_id === "string" ? body.lead_id : "";
    if (!leadId) throw new PublicApiError(422, "invalid_appointment", "leadId is required.");
    const engagement = await getLeadEngagement(ctx.org.id, leadId).catch(() => null);
    if (!engagement) throw new PublicApiError(404, "not_found", "Lead not found.");

    const rawType = typeof body.appointmentType === "string" ? body.appointmentType : typeof body.appointment_type === "string" ? body.appointment_type : "estimate";
    if (!isAppointmentType(rawType)) throw new PublicApiError(422, "invalid_appointment", `Unknown appointmentType: ${rawType}.`);
    const scheduledStart = typeof body.scheduledStart === "string" ? body.scheduledStart : typeof body.scheduled_start === "string" ? body.scheduled_start : "";
    if (!scheduledStart || Number.isNaN(Date.parse(scheduledStart))) {
      throw new PublicApiError(422, "invalid_appointment", "scheduledStart must be a valid ISO date/time.");
    }
    const scheduledEndRaw = body.scheduledEnd ?? body.scheduled_end;
    const scheduledEnd = typeof scheduledEndRaw === "string" && !Number.isNaN(Date.parse(scheduledEndRaw)) ? scheduledEndRaw : null;

    const appointment = await createAppointment({
      organizationId: ctx.org.id,
      leadId,
      appointmentType: rawType,
      scheduledStart,
      scheduledEnd,
      timezone: typeof body.timezone === "string" ? body.timezone : null,
      address: typeof body.address === "string" ? body.address : null,
      projectDetails: typeof body.projectDetails === "string" ? body.projectDetails : null,
      notes: typeof body.notes === "string" ? body.notes : null,
      createdBy: null,
    });
    if (!appointment) throw new PublicApiError(500, "internal_error", "Appointment could not be created.");
    emitOrgEventInBackground(ctx.org.id, "appointment.created", { appointment_id: appointment.id, lead_id: leadId, source: "public_api" });
    // Best-effort calendar push — never fails the booking.
    void pushAppointmentToCalendar(ctx.org.id, appointment.id);
    // Email the org's saved notification addresses (Settings → Notifications).
    sendOrgAlertInBackground(
      ctx.org.id,
      "appointmentAlerts",
      buildAppointmentAlertEmail({
        orgName: ctx.org.name,
        leadName: [appointment.leadFirstName, appointment.leadLastName].filter(Boolean).join(" ") || "Unnamed lead",
        appointmentType: rawType,
        scheduledStart,
        timezone: appointment.timezone,
        address: appointment.address,
        source: "Public API",
      }),
    );
    return { status: 201, body: { data: appointment }, headers: ctx.rateHeaders };
  });
});
