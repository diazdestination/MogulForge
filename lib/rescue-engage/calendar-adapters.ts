/**
 * Provider-neutral calendar adapter layer. Pure module.
 *
 * Manual scheduling is the only working provider today. The external adapters
 * are honestly stubbed: they report `connected: false` and the UI must never
 * claim an external calendar is synced. When credentials/OAuth exist, implement
 * `createEvent`/`cancelEvent` for the matching provider id.
 */

export const APPOINTMENT_PROVIDERS = ["manual", "google_calendar", "outlook_calendar", "calendly", "booking_url"] as const;
export type AppointmentProvider = (typeof APPOINTMENT_PROVIDERS)[number];

export type CalendarAdapterStatus = {
  id: AppointmentProvider;
  label: string;
  connected: boolean;
  detail: string;
};

export function listCalendarAdapters(): CalendarAdapterStatus[] {
  return [
    { id: "manual", label: "Manual scheduling", connected: true, detail: "Appointments are tracked in Revenue Rescue and managed by your team." },
    { id: "google_calendar", label: "Google Calendar", connected: false, detail: "Not connected. OAuth setup is required before events can sync." },
    { id: "outlook_calendar", label: "Outlook Calendar", connected: false, detail: "Not connected. Microsoft account authorization is required before events can sync." },
    { id: "calendly", label: "Calendly", connected: false, detail: "Not connected. A Calendly API token is required before booking links can sync." },
    { id: "booking_url", label: "Generic booking URL", connected: false, detail: "Share a booking link in messages; bookings made there are not synced back automatically." },
  ];
}

export const APPOINTMENT_STATUSES = ["requested", "confirmed", "rescheduled", "completed", "cancelled", "no_show"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  requested: "Requested",
  confirmed: "Confirmed",
  rescheduled: "Rescheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No-show",
};

export const APPOINTMENT_TYPES = ["estimate", "inspection", "consultation", "follow_up", "other"] as const;
export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];

export function isAppointmentStatus(value: string): value is AppointmentStatus {
  return (APPOINTMENT_STATUSES as readonly string[]).includes(value);
}

export function isAppointmentType(value: string): value is AppointmentType {
  return (APPOINTMENT_TYPES as readonly string[]).includes(value);
}
