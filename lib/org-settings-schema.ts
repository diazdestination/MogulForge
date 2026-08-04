import { CAMPAIGN_TONES, type CampaignTone } from "./rescue-engage/campaign-schema.ts";

/**
 * Organization settings shape + normalization. Pure module — no server-only
 * imports, directly unit-testable. The database stores an arbitrary jsonb
 * blob; every read passes through normalizeOrgSettings so the rest of the
 * app only ever sees a fully-populated, validated structure.
 */

export type OrgContactSettings = {
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  website: string;
  address: string;
};

export type BusinessHoursSettings = {
  /** "HH:MM" 24h */
  start: string;
  end: string;
  /** Days of week, 0 = Sunday … 6 = Saturday */
  days: number[];
};

export type NotificationSettings = {
  hotLeadAlerts: boolean;
  replyAlerts: boolean;
  appointmentAlerts: boolean;
  crmConnectionAlerts: boolean;
  /** Alert when the org's own Google/Outlook calendar connection stops syncing. */
  calendarConnectionAlerts: boolean;
  /** Alert when the org's active custom domain stops resolving correctly. */
  customDomainAlerts: boolean;
  weeklyDigest: boolean;
  /** Reminder email a few days before a scheduled plan downgrade takes effect. */
  planChangeReminders: boolean;
  notificationEmails: string[];
};

export type MessagingSettings = {
  /** Local hour (0–23) after which no automated messages go out. */
  quietHoursStart: number;
  /** Local hour (0–23) before which no automated messages go out. */
  quietHoursEnd: number;
  defaultTone: CampaignTone;
  defaultSenderName: string;
  defaultBookingLink: string;
};

export const CALENDAR_SYNC_PROVIDERS = ["none", "google_calendar", "outlook_calendar"] as const;
export type CalendarSyncProvider = (typeof CALENDAR_SYNC_PROVIDERS)[number];

export type CalendarSettings = {
  /** Which connected calendar new appointments are pushed to ("none" disables push). */
  syncProvider: CalendarSyncProvider;
  /** The org's public Calendly scheduling link (e.g. https://calendly.com/acme/estimate). */
  calendlyUrl: string;
};

export type OrgSettings = {
  contact: OrgContactSettings;
  businessHours: BusinessHoursSettings;
  notifications: NotificationSettings;
  messaging: MessagingSettings;
  calendar: CalendarSettings;
};

export const ORG_SETTINGS_SECTIONS = ["contact", "businessHours", "notifications", "messaging", "calendar"] as const;
export type OrgSettingsSection = (typeof ORG_SETTINGS_SECTIONS)[number];

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  contact: { contactName: "", contactEmail: "", contactPhone: "", website: "", address: "" },
  businessHours: { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] },
  notifications: { hotLeadAlerts: true, replyAlerts: true, appointmentAlerts: true, crmConnectionAlerts: true, calendarConnectionAlerts: true, customDomainAlerts: true, weeklyDigest: false, planChangeReminders: true, notificationEmails: [] },
  messaging: { quietHoursStart: 20, quietHoursEnd: 8, defaultTone: "professional", defaultSenderName: "", defaultBookingLink: "" },
  calendar: { syncProvider: "none", calendlyUrl: "" },
};

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(value: unknown, fallback: string, maxLength = 300): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function hour(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 23) return fallback;
  return n;
}

function timeOfDay(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !TIME_RE.test(value.trim())) return fallback;
  const [h, m] = value.trim().split(":");
  return `${h.padStart(2, "0")}:${m}`;
}

function dayList(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value)) return [...fallback];
  const days = [...new Set(value.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  return days.sort((a, b) => a - b);
}

function emailList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const emails = value
    .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
    .filter((v) => v && EMAIL_RE.test(v));
  return [...new Set(emails)].slice(0, 10);
}

function tone(value: unknown, fallback: CampaignTone): CampaignTone {
  return (CAMPAIGN_TONES as readonly string[]).includes(String(value)) ? (value as CampaignTone) : fallback;
}

function syncProvider(value: unknown, fallback: CalendarSyncProvider): CalendarSyncProvider {
  return (CALENDAR_SYNC_PROVIDERS as readonly string[]).includes(String(value)) ? (value as CalendarSyncProvider) : fallback;
}

/** Calendly links must be https URLs on calendly.com (or empty to clear). */
export function normalizeCalendlyUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, 300);
  if (trimmed === "") return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return fallback;
    if (!(url.hostname === "calendly.com" || url.hostname.endsWith(".calendly.com"))) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function section(raw: unknown): Record<string, any> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Normalizes an arbitrary stored/submitted blob into a full OrgSettings,
 * merging over `base` (defaults when omitted). Unknown keys are dropped and
 * invalid values fall back to the base value — never to garbage.
 */
export function normalizeOrgSettings(raw: unknown, base: OrgSettings = DEFAULT_ORG_SETTINGS): OrgSettings {
  const root = section(raw);
  const contact = section(root.contact);
  const hours = section(root.businessHours);
  const notif = section(root.notifications);
  const msg = section(root.messaging);
  const cal = section(root.calendar);
  return {
    contact: {
      contactName: str(contact.contactName, base.contact.contactName, 120),
      contactEmail: ((v) => (v === "" || EMAIL_RE.test(v) ? v : base.contact.contactEmail))(str(contact.contactEmail, base.contact.contactEmail, 320).toLowerCase()),
      contactPhone: str(contact.contactPhone, base.contact.contactPhone, 40),
      website: str(contact.website, base.contact.website, 300),
      address: str(contact.address, base.contact.address, 400),
    },
    businessHours: {
      start: timeOfDay(hours.start, base.businessHours.start),
      end: timeOfDay(hours.end, base.businessHours.end),
      days: dayList(hours.days, base.businessHours.days),
    },
    notifications: {
      hotLeadAlerts: bool(notif.hotLeadAlerts, base.notifications.hotLeadAlerts),
      replyAlerts: bool(notif.replyAlerts, base.notifications.replyAlerts),
      appointmentAlerts: bool(notif.appointmentAlerts, base.notifications.appointmentAlerts),
      crmConnectionAlerts: bool(notif.crmConnectionAlerts, base.notifications.crmConnectionAlerts),
      calendarConnectionAlerts: bool(notif.calendarConnectionAlerts, base.notifications.calendarConnectionAlerts),
      customDomainAlerts: bool(notif.customDomainAlerts, base.notifications.customDomainAlerts),
      weeklyDigest: bool(notif.weeklyDigest, base.notifications.weeklyDigest),
      planChangeReminders: bool(notif.planChangeReminders, base.notifications.planChangeReminders),
      notificationEmails: emailList(notif.notificationEmails, base.notifications.notificationEmails),
    },
    messaging: {
      quietHoursStart: hour(msg.quietHoursStart, base.messaging.quietHoursStart),
      quietHoursEnd: hour(msg.quietHoursEnd, base.messaging.quietHoursEnd),
      defaultTone: tone(msg.defaultTone, base.messaging.defaultTone),
      defaultSenderName: str(msg.defaultSenderName, base.messaging.defaultSenderName, 120),
      defaultBookingLink: str(msg.defaultBookingLink, base.messaging.defaultBookingLink, 300),
    },
    calendar: {
      syncProvider: syncProvider(cal.syncProvider, base.calendar.syncProvider),
      calendlyUrl: normalizeCalendlyUrl(cal.calendlyUrl, base.calendar.calendlyUrl),
    },
  };
}

/** Which top-level sections a submitted patch actually touches (for audit metadata). */
export function touchedSections(patch: unknown): OrgSettingsSection[] {
  const root = section(patch);
  return ORG_SETTINGS_SECTIONS.filter((key) => root[key] !== undefined && root[key] !== null);
}
