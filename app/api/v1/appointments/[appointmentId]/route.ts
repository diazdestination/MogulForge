import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, PublicApiError, readV1Json } from "@/lib/public-api/http";
import { isAppointmentStatus } from "@/lib/rescue-engage/calendar-adapters";
import { getAppointment, updateAppointment } from "@/lib/rescue-engage/store";
import { emitOrgEventInBackground } from "@/lib/webhooks/outgoing";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ appointmentId: string }> };

/** GET /api/v1/appointments/:id — appointment detail. Scope: appointments:read. */
export const GET = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "appointments:read");
  const { appointmentId } = await params;
  const appointment = await getAppointment(ctx.org.id, appointmentId).catch(() => null);
  if (!appointment) throw new PublicApiError(404, "not_found", "Appointment not found.");
  return NextResponse.json({ data: appointment }, { headers: ctx.rateHeaders });
});

/** PATCH /api/v1/appointments/:id — update status/schedule/notes. Scope: appointments:write. */
export const PATCH = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "appointments:write");
  const { appointmentId } = await params;
  const body = await readV1Json(request);
  const existing = await getAppointment(ctx.org.id, appointmentId).catch(() => null);
  if (!existing) throw new PublicApiError(404, "not_found", "Appointment not found.");

  const patch: Parameters<typeof updateAppointment>[2] = {};
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !isAppointmentStatus(body.status)) {
      throw new PublicApiError(422, "invalid_appointment", `Unknown status: ${String(body.status)}.`);
    }
    patch.status = body.status;
  }
  const start = body.scheduledStart ?? body.scheduled_start;
  if (start !== undefined) {
    if (typeof start !== "string" || Number.isNaN(Date.parse(start))) {
      throw new PublicApiError(422, "invalid_appointment", "scheduledStart must be a valid ISO date/time.");
    }
    patch.scheduledStart = start;
  }
  const end = body.scheduledEnd ?? body.scheduled_end;
  if (end !== undefined) {
    if (end !== null && (typeof end !== "string" || Number.isNaN(Date.parse(end)))) {
      throw new PublicApiError(422, "invalid_appointment", "scheduledEnd must be null or a valid ISO date/time.");
    }
    patch.scheduledEnd = end as string | null;
  }
  if (body.notes !== undefined) patch.notes = body.notes === null ? null : String(body.notes).slice(0, 4000);
  if (body.address !== undefined) patch.address = body.address === null ? null : String(body.address).slice(0, 500);
  if (Object.keys(patch).length === 0) throw new PublicApiError(422, "invalid_appointment", "No updatable fields provided.");

  const updated = await updateAppointment(ctx.org.id, appointmentId, patch);
  if (!updated) throw new PublicApiError(404, "not_found", "Appointment not found.");
  emitOrgEventInBackground(ctx.org.id, "appointment.updated", { appointment_id: appointmentId, source: "public_api" });
  return NextResponse.json({ data: updated }, { headers: ctx.rateHeaders });
});
