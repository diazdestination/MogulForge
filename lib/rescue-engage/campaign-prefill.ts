/**
 * Initial values for the new-campaign form. Pure module — unit-testable.
 *
 * Saved org messaging defaults (Settings → Messaging) prefill tone, sender
 * name, booking link, and quiet hours; every value stays overridable per
 * campaign. When no defaults are available (not loaded / fetch failed) the
 * form behaves exactly as before, falling back to the template values and
 * the built-in defaults.
 */
import type { CampaignTemplate } from "./campaign-templates.ts";
import type { LeadCategory } from "../rescue-analysis/categories.ts";

export type MessagingDefaults = {
  quietHoursStart: number;
  quietHoursEnd: number;
  defaultTone: string;
  defaultSenderName: string;
  defaultBookingLink: string;
};

export type CampaignFormState = {
  templateKey: string | null;
  name: string;
  channel: "sms" | "email";
  tone: string;
  objective: string;
  categories: LeadCategory[];
  minScore: string;
  approvalMode: string;
  startDate: string;
  quietHoursStart: number;
  quietHoursEnd: number;
  stopConditions: string[];
  followUpDelayDays: number;
  maxAttempts: number;
  senderIdentity: string;
  bookingLink: string;
};

export function initialCampaignForm(
  template: CampaignTemplate | null,
  defaults: MessagingDefaults | null,
): CampaignFormState {
  return {
    templateKey: template?.key ?? null,
    name: template?.name ?? "",
    channel: template?.channel ?? "sms",
    // Saved default tone wins over the template's suggested tone; the user
    // can still change it per campaign in the form.
    tone: defaults?.defaultTone ?? template?.tone ?? "professional",
    objective: template?.objective ?? "",
    categories: template ? [...template.audience.categories] : [],
    minScore: template?.audience.minScore != null ? String(template.audience.minScore) : "",
    approvalMode: "simulation_only",
    startDate: "",
    quietHoursStart: defaults?.quietHoursStart ?? 20,
    quietHoursEnd: defaults?.quietHoursEnd ?? 8,
    stopConditions: ["reply", "opt_out", "appointment_booked", "max_attempts"],
    followUpDelayDays: 3,
    maxAttempts: 3,
    senderIdentity: defaults?.defaultSenderName ?? "",
    bookingLink: defaults?.defaultBookingLink ?? "",
  };
}
