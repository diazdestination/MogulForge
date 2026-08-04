import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { buildAppointmentAlertEmail } from "@/lib/org-alerts-content";
import { sendOrgAlertInBackground } from "@/lib/org-alerts";
import { createAppointment, getLeadEngagement, listAppointments, logActivity, setLeadStage } from "@/lib/rescue-engage/store";
import { isAppointmentStatus, isAppointmentType, resolveCalendarAdapters } from "@/lib/rescue-engage/calendar-adapters";
import { getConnectedCalendarProviders } from "@/lib/calendar/connections";
import { listOrgCalendarConnections } from "@/lib/calendar/org-connections";
import { getOAuthAppCredentials } from "@/lib/calendar/oauth-config";
import { pushAppointmentToCalendar } from "@/lib/calendar/sync";
import { getOrgSettings } from "@/lib/org-settings";
import { buildBookingUrl } from "@/lib/booking-token";
import { APPOINTMENT_WRITE_ROLES, ASSIGNED_ONLY_ROLES, MANAGER_ROLES } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Appointments list + real calendar adapter state (live connector status + org calendar settings). */
export const GET = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "appointments");
  const restricted = ASSIGNED_ONLY_ROLES.includes(role);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  if (status && !isAppointmentStatus(status)) throw new ApiError(400, "Unknown status filter.");
  const [appointments, connected, settings, orgConnections] = await Promise.all([
    listAppointments(org.id, {
      assignedUserId: restricted ? user.id : undefined,
      status: status && isAppointmentStatus(status) ? status : undefined,
    }),
    getConnectedCalendarProviders(),
    getOrgSettings(org.id),
    listOrgCalendarConnections(org.id),
  ]);
  const orgGoogle = orgConnections.find((c) => c.provider === "google_calendar") ?? null;
  const orgOutlook = orgConnections.find((c) => c.provider === "outlook_calendar") ?? null;
  const bookingUrl = buildBookingUrl(url.origin, org.id);
  return NextResponse.json({
    appointments,
    adapters: resolveCalendarAdapters({
      // An org's own OAuth connection counts as connected even when the
      // workspace-level connector isn't authorized.
      google: Boolean(orgGoogle) || connected.google,
      outlook: Boolean(orgOutlook) || connected.outlook,
      calendly: connected.calendly,
      syncProvider: settings.calendar.syncProvider,
      calendlyUrl: settings.calendar.calendlyUrl,
      bookingUrl,
    }),
    calendar: {
      ...settings.calendar,
      bookingUrl,
      connections: {
        google: Boolean(orgGoogle) || connected.google,
        outlook: Boolean(orgOutlook) || connected.outlook,
        calendly: connected.calendly,
      },
      // Per-org OAuth state for the "Your calendar accounts" UI.
      orgAccounts: {
        google: orgGoogle
          ? { connected: true, accountEmail: orgGoogle.accountEmail, broken: orgGoogle.status === "error" }
          : { connected: false, accountEmail: null, broken: false },
        outlook: orgOutlook
          ? { connected: true, accountEmail: orgOutlook.accountEmail, broken: orgOutlook.status === "error" }
          : { connected: false, accountEmail: null, broken: false },
        oauthConfigured: {
          google: Boolean(getOAuthAppCredentials("google_calendar")),
          outlook: Boolean(getOAuthAppCredentials("outlook_calendar")),
        },
        workspaceFallback: { google: connected.google, outlook: connected.outlook },
      },
      canConfigure: MANAGER_ROLES.includes(role),
    },
    scopedToAssigned: restricted,
  });
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
  // Email the org's saved notification addresses (Settings → Notifications).
  sendOrgAlertInBackground(
    org.id,
    "appointmentAlerts",
    buildAppointmentAlertEmail({
      orgName: org.name,
      leadName: [appointment.leadFirstName, appointment.leadLastName].filter(Boolean).join(" ") || "Unnamed lead",
      appointmentType,
      scheduledStart,
      timezone: appointment.timezone,
      address: appointment.address,
      source: "Dashboard",
    }),
  );
  // Best-effort calendar push — never fails the booking.
  await pushAppointmentToCalendar(org.id, appointment.id);
  return NextResponse.json({ appointment }, { status: 201 });
});
