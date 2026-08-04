/**
 * Provider-neutral calendar adapter layer. Pure module.
 *
 * Adapter statuses are RESOLVED from real state, never hardcoded:
 * `resolveCalendarAdapters` combines the workspace's live connector state
 * (Google Calendar / Outlook / Calendly OAuth, checked server-side in
 * lib/calendar/connections.ts) with the org's calendar settings. The UI must
 * never claim an external calendar is synced unless the connection is real.
 */

export const APPOINTMENT_PROVIDERS = ["manual", "google_calendar", "outlook_calendar", "calendly", "booking_url"] as const;
export type AppointmentProvider = (typeof APPOINTMENT_PROVIDERS)[number];

export type CalendarAdapterStatus = {
  id: AppointmentProvider;
  label: string;
  connected: boolean;
  detail: string;
};

export type CalendarAdapterInput = {
  /** Live connector state — which OAuth connections actually exist right now. */
  google: boolean;
  outlook: boolean;
  calendly: boolean;
  /** Org preference: which connected calendar appointments push to. */
  syncProvider: "none" | "google_calendar" | "outlook_calendar";
  /** Org's Calendly scheduling link ("" when unset). */
  calendlyUrl: string;
  /** The org's Revenue Rescue booking-page link ("" when it can't be built). */
  bookingUrl: string;
};

export function resolveCalendarAdapters(input: CalendarAdapterInput): CalendarAdapterStatus[] {
  const googleActive = input.google && input.syncProvider === "google_calendar";
  const outlookActive = input.outlook && input.syncProvider === "outlook_calendar";
  return [
    { id: "manual", label: "Manual scheduling", connected: true, detail: "Appointments are tracked in Revenue Rescue and managed by your team." },
    {
      id: "google_calendar",
      label: "Google Calendar",
      connected: googleActive,
      detail: googleActive
        ? "Connected. New bookings create Google Calendar events; cancellations and reschedules sync both ways."
        : input.google
          ? "Authorized but not active. Choose Google Calendar as the sync target below to push bookings."
          : "Not connected. Authorize the Google Calendar connection to sync events.",
    },
    {
      id: "outlook_calendar",
      label: "Outlook Calendar",
      connected: outlookActive,
      detail: outlookActive
        ? "Connected. New bookings create Outlook events; cancellations and reschedules sync both ways."
        : input.outlook
          ? "Authorized but not active. Choose Outlook Calendar as the sync target below to push bookings."
          : "Not connected. Authorize the Microsoft Outlook connection to sync events.",
    },
    {
      id: "calendly",
      label: "Calendly",
      connected: input.calendly && input.calendlyUrl !== "",
      detail: input.calendly && input.calendlyUrl !== ""
        ? "Connected. Calendly bookings and cancellations sync into Revenue Rescue on a schedule."
        : input.calendly
          ? "Authorized. Add your Calendly scheduling link below to match bookings to this workspace."
          : "Not connected. Authorize the Calendly connection so bookings sync back automatically.",
    },
    {
      id: "booking_url",
      label: "Booking link",
      connected: input.bookingUrl !== "",
      detail: input.bookingUrl !== ""
        ? "Share your Revenue Rescue booking link in campaign messages — bookings land here automatically."
        : "Booking link unavailable — SESSION_SECRET must be configured to sign booking links.",
    },
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
