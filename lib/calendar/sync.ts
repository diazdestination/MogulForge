import "server-only";
import { getPool } from "../db";
import { getOrgSettings } from "../org-settings";
import type { OrgSettings } from "../org-settings-schema";
import { connectorRequest, getConnectedCalendarProviders } from "./connections";
import {
  createAppointment,
  externalEventExists,
  findLeadIdByEmail,
  getAppointment,
  listSyncedAppointmentRefs,
  logActivity,
  setAppointmentExternalRef,
  updateAppointment,
  type Appointment,
} from "../rescue-engage/store";

/**
 * Two-way calendar sync.
 *
 * Outbound (push): booking/rescheduling/cancelling an appointment in Revenue
 * Rescue mirrors the change to the org's configured calendar (Google or
 * Outlook via the workspace's Replit connectors). Push failures NEVER fail the
 * appointment write — the appointment is the source of truth; sync is
 * best-effort and logged.
 *
 * Inbound (pull, runCalendarSync): a cron pass detects events cancelled or
 * moved in the external calendar and updates the appointment, and imports new
 * Calendly bookings (matched to leads by invitee email) into
 * rescue_appointments.
 */

const DEFAULT_DURATION_MS = 60 * 60 * 1000;

function eventTimes(appt: { scheduledStart: string; scheduledEnd: string | null }) {
  const start = new Date(appt.scheduledStart);
  const end = appt.scheduledEnd ? new Date(appt.scheduledEnd) : new Date(start.getTime() + DEFAULT_DURATION_MS);
  return { start, end };
}

function eventSummary(appt: Appointment) {
  const lead = [appt.leadFirstName, appt.leadLastName].filter(Boolean).join(" ") || "Lead";
  return `${appt.appointmentType.replace("_", " ")} — ${lead}`;
}

function eventDescription(appt: Appointment) {
  return [
    appt.projectDetails ? `Project: ${appt.projectDetails}` : null,
    appt.notes ? `Notes: ${appt.notes}` : null,
    appt.leadPhone ? `Phone: ${appt.leadPhone}` : null,
    appt.leadEmail ? `Email: ${appt.leadEmail}` : null,
    "Booked via Revenue Rescue.",
  ].filter(Boolean).join("\n");
}

type GoogleEvent = { id?: string; status?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } };
/**
 * Graph dateTime+timeZone wrapper. When fetched with `Prefer: outlook.timezone="UTC"`,
 * timeZone will be "UTC" and dateTime will already be in UTC — no conversion needed.
 */
type OutlookEvent = {
  id?: string;
  isCancelled?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
};

async function pushCreate(provider: "google_calendar" | "outlook_calendar", appt: Appointment): Promise<string | null> {
  const { start, end } = eventTimes(appt);
  if (provider === "google_calendar") {
    const { data } = await connectorRequest<GoogleEvent>("google-calendar", "/calendar/v3/calendars/primary/events", {
      method: "POST",
      body: {
        summary: eventSummary(appt),
        description: eventDescription(appt),
        location: appt.address ?? undefined,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      },
    });
    return data?.id ?? null;
  }
  const { data } = await connectorRequest<OutlookEvent>("outlook", "/v1.0/me/events", {
    method: "POST",
    body: {
      subject: eventSummary(appt),
      body: { contentType: "text", content: eventDescription(appt) },
      location: appt.address ? { displayName: appt.address } : undefined,
      start: { dateTime: start.toISOString(), timeZone: "UTC" },
      end: { dateTime: end.toISOString(), timeZone: "UTC" },
    },
  });
  return data?.id ?? null;
}

/** Push a freshly booked appointment to the org's configured calendar. Best-effort. */
export async function pushAppointmentToCalendar(organizationId: string, appointmentId: string): Promise<void> {
  try {
    const settings = await getOrgSettings(organizationId);
    const provider = settings.calendar.syncProvider;
    if (provider === "none") return;
    const connected = await getConnectedCalendarProviders();
    if ((provider === "google_calendar" && !connected.google) || (provider === "outlook_calendar" && !connected.outlook)) return;
    const appt = await getAppointment(organizationId, appointmentId);
    if (!appt || appt.externalEventId) return;
    const eventId = await pushCreate(provider, appt);
    if (eventId) {
      await setAppointmentExternalRef(organizationId, appointmentId, provider, eventId);
      await logActivity({
        organizationId,
        leadId: appt.leadId,
        activityType: "appointment_booked",
        title: `Calendar event created (${provider === "google_calendar" ? "Google Calendar" : "Outlook"})`,
        detail: `Synced appointment scheduled for ${appt.scheduledStart}`,
        actorUserId: null,
      });
    }
  } catch (error) {
    console.error(`Calendar push failed for appointment ${appointmentId}`, error);
  }
}

/** Mirror a reschedule/cancel/status change to the backing calendar event. Best-effort. */
export async function pushAppointmentUpdateToCalendar(organizationId: string, appointmentId: string): Promise<void> {
  try {
    const appt = await getAppointment(organizationId, appointmentId);
    if (!appt || !appt.externalEventId) return;
    if (appt.provider !== "google_calendar" && appt.provider !== "outlook_calendar") return;
    const connected = await getConnectedCalendarProviders();
    if ((appt.provider === "google_calendar" && !connected.google) || (appt.provider === "outlook_calendar" && !connected.outlook)) return;

    const cancelled = appt.status === "cancelled";
    const { start, end } = eventTimes(appt);
    if (appt.provider === "google_calendar") {
      if (cancelled) {
        await connectorRequest("google-calendar", `/calendar/v3/calendars/primary/events/${encodeURIComponent(appt.externalEventId)}`, { method: "DELETE", allow404: true });
      } else {
        await connectorRequest("google-calendar", `/calendar/v3/calendars/primary/events/${encodeURIComponent(appt.externalEventId)}`, {
          method: "PATCH",
          allow404: true,
          body: { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } },
        });
      }
    } else if (cancelled) {
      await connectorRequest("outlook", `/v1.0/me/events/${encodeURIComponent(appt.externalEventId)}`, { method: "DELETE", allow404: true });
    } else {
      await connectorRequest("outlook", `/v1.0/me/events/${encodeURIComponent(appt.externalEventId)}`, {
        method: "PATCH",
        allow404: true,
        body: { start: { dateTime: start.toISOString(), timeZone: "UTC" }, end: { dateTime: end.toISOString(), timeZone: "UTC" } },
      });
    }
  } catch (error) {
    console.error(`Calendar update push failed for appointment ${appointmentId}`, error);
  }
}

export type CalendarSyncResult = {
  checked: number;
  cancelled: number;
  rescheduled: number;
  calendlyImported: number;
  calendlyCancelled: number;
  errors: number;
};

async function pullEventChanges(result: CalendarSyncResult): Promise<void> {
  const connected = await getConnectedCalendarProviders(true);
  const providers: Array<"google_calendar" | "outlook_calendar"> = [];
  if (connected.google) providers.push("google_calendar");
  if (connected.outlook) providers.push("outlook_calendar");
  if (providers.length === 0) return;

  const refs = await listSyncedAppointmentRefs(providers);
  for (const ref of refs) {
    result.checked += 1;
    try {
      let externalStart: string | null = null;
      let externalCancelled = false;
      if (ref.provider === "google_calendar") {
        const { status, data } = await connectorRequest<GoogleEvent>(
          "google-calendar", `/calendar/v3/calendars/primary/events/${encodeURIComponent(ref.externalEventId)}`, { allow404: true },
        );
        externalCancelled = status === 404 || data?.status === "cancelled";
        externalStart = data?.start?.dateTime ?? null;
      } else {
        // Request Graph to return all dateTime values in UTC so we never need to
        // convert — the Prefer header forces server-side timezone conversion.
        const { status, data } = await connectorRequest<OutlookEvent>(
          "outlook", `/v1.0/me/events/${encodeURIComponent(ref.externalEventId)}`,
          { allow404: true, headers: { "Prefer": 'outlook.timezone="UTC"' } },
        );
        externalCancelled = status === 404 || data?.isCancelled === true;
        // With the Prefer header, dateTime is already in UTC; append Z only if
        // Graph omits the trailing Z (which it sometimes does even in UTC mode).
        if (data?.start?.dateTime) {
          const raw = data.start.dateTime;
          externalStart = raw.endsWith("Z") || raw.includes("+") ? raw : `${raw}Z`;
        }
      }
      if (externalCancelled) {
        await updateAppointment(ref.organizationId, ref.id, { status: "cancelled" });
        result.cancelled += 1;
        continue;
      }
      if (externalStart) {
        const drift = Math.abs(new Date(externalStart).getTime() - new Date(ref.scheduledStart).getTime());
        if (Number.isFinite(drift) && drift > 60_000) {
          await updateAppointment(ref.organizationId, ref.id, { status: "rescheduled", scheduledStart: new Date(externalStart).toISOString() });
          result.rescheduled += 1;
        }
      }
    } catch (error) {
      result.errors += 1;
      console.error(`Calendar pull failed for appointment ${ref.id}`, error);
    }
  }
}

type CalendlyEvent = {
  uri?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  name?: string;
  event_type?: string;
};
type CalendlyEventType = { uri?: string; scheduling_url?: string };
type CalendlyInvitee = { email?: string; name?: string };

/** Normalize a Calendly scheduling URL for comparison: lowercase, strip trailing slash. */
function normalizeCalendlyUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, "").trim();
}

async function orgsWithCalendly(): Promise<Array<{ id: string; calendlyUrl: string }>> {
  const { rows } = await getPool().query(
    `SELECT id, settings->'calendar'->>'calendlyUrl' AS calendly_url
     FROM organizations
     WHERE coalesce(settings->'calendar'->>'calendlyUrl', '') <> ''`,
  );
  return rows.map((r) => ({ id: r.id, calendlyUrl: r.calendly_url as string }));
}

async function pullCalendlyBookings(result: CalendarSyncResult): Promise<void> {
  const connected = await getConnectedCalendarProviders();
  if (!connected.calendly) return;
  const orgs = await orgsWithCalendly();
  if (orgs.length === 0) return;

  const me = await connectorRequest<{ resource?: { uri?: string } }>("calendly", "/v2/users/me");
  const userUri = me.data?.resource?.uri;
  if (!userUri) return;

  // Fetch all event types for the workspace account once, then map each org's
  // configured scheduling URL to its canonical event-type URI. This scopes each
  // org strictly to its own Calendly event type — events from other types are
  // never attributed to an org, even when an invitee email matches a lead there.
  const eventTypesResp = await connectorRequest<{ collection?: CalendlyEventType[] }>(
    "calendly", `/v2/event_types?user=${encodeURIComponent(userUri)}&count=100`,
  );
  const eventTypes = eventTypesResp.data?.collection ?? [];

  type OrgWithEventType = { id: string; calendlyUrl: string; eventTypeUri: string };
  const orgsWithEventType: OrgWithEventType[] = [];
  for (const org of orgs) {
    const normalized = normalizeCalendlyUrl(org.calendlyUrl);
    const match = eventTypes.find(
      (et) => et.scheduling_url && normalizeCalendlyUrl(et.scheduling_url) === normalized,
    );
    if (match?.uri) {
      orgsWithEventType.push({ ...org, eventTypeUri: match.uri });
    }
    // If no event type matches the org's URL, skip — events cannot be attributed safely.
  }
  if (orgsWithEventType.length === 0) return;

  const minStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  for (const org of orgsWithEventType) {
    try {
      // Fetch events scoped to this org's specific event type URI.
      const listPath =
        `/v2/scheduled_events?event_type=${encodeURIComponent(org.eventTypeUri)}` +
        `&min_start_time=${encodeURIComponent(minStart)}&count=100&sort=start_time:desc`;
      const list = await connectorRequest<{ collection?: CalendlyEvent[] }>("calendly", listPath);
      const events = list.data?.collection ?? [];

      for (const event of events) {
        if (!event.uri || !event.start_time) continue;
        const eventId = event.uri;
        const isActive = event.status === "active";

        const exists = await externalEventExists(org.id, eventId);
        if (exists) {
          if (!isActive) {
            const { rows } = await getPool().query(
              `SELECT id FROM rescue_appointments WHERE organization_id = $1 AND external_event_id = $2
               AND status IN ('requested', 'confirmed', 'rescheduled') LIMIT 1`,
              [org.id, eventId],
            );
            if (rows[0]) {
              await updateAppointment(org.id, rows[0].id, { status: "cancelled" });
              result.calendlyCancelled += 1;
            }
          }
          continue;
        }
        if (!isActive) continue;

        const uuid = eventId.split("/").pop();
        const invitees = await connectorRequest<{ collection?: CalendlyInvitee[] }>(
          "calendly", `/v2/scheduled_events/${uuid}/invitees?count=1`,
        );
        const email = invitees.data?.collection?.[0]?.email;
        if (!email) continue;
        const leadId = await findLeadIdByEmail(org.id, email);
        if (!leadId) continue;

        const appt = await createAppointment({
          organizationId: org.id,
          leadId,
          appointmentType: "consultation",
          scheduledStart: event.start_time,
          scheduledEnd: event.end_time ?? null,
          notes: event.name ? `Calendly: ${event.name}` : "Booked via Calendly",
          createdBy: null,
          provider: "calendly",
          externalEventId: eventId,
        });
        if (appt) {
          result.calendlyImported += 1;
          await logActivity({
            organizationId: org.id,
            leadId,
            activityType: "appointment_booked",
            title: "Appointment booked via Calendly",
            detail: `Scheduled for ${event.start_time}`,
            actorUserId: null,
          });
        }
      }
    } catch (error) {
      result.errors += 1;
      console.error(`Calendly sync failed for org ${org.id}`, error);
    }
  }
}

/** Full inbound sync pass (cron): external cancellations/reschedules + new Calendly bookings. */
export async function runCalendarSync(): Promise<CalendarSyncResult> {
  const result: CalendarSyncResult = { checked: 0, cancelled: 0, rescheduled: 0, calendlyImported: 0, calendlyCancelled: 0, errors: 0 };
  await pullEventChanges(result);
  await pullCalendlyBookings(result);
  return result;
}
