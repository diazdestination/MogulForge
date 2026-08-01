import { z } from "zod";

/** Intake wizard payload. Shared by the client wizard and the intake API. */

export const LEAD_SOURCE_OPTIONS = [
  { value: "crm_export", label: "CRM export" },
  { value: "old_estimates", label: "Old estimates & unsold proposals" },
  { value: "missed_calls", label: "Missed / unreturned calls" },
  { value: "website_forms", label: "Website form inquiries" },
  { value: "facebook_ads", label: "Facebook lead ads" },
  { value: "google_ads", label: "Google Ads leads" },
  { value: "spreadsheets", label: "Spreadsheets kept by the team" },
  { value: "other", label: "Other" },
] as const;

export const CHANNEL_OPTIONS = [
  { value: "sms", label: "Text messages (SMS)" },
  { value: "email", label: "Email" },
  { value: "calls", label: "Phone calls by my team" },
] as const;

export const TONE_OPTIONS = [
  { value: "professional", label: "Professional & direct" },
  { value: "friendly", label: "Friendly & conversational" },
  { value: "urgent", label: "Urgency-driven (seasonal, storm, deadline)" },
] as const;

const sourceValues = LEAD_SOURCE_OPTIONS.map((o) => o.value) as [string, ...string[]];
const channelValues = CHANNEL_OPTIONS.map((o) => o.value) as [string, ...string[]];
const toneValues = TONE_OPTIONS.map((o) => o.value) as [string, ...string[]];

export const rescueIntakeSchema = z.object({
  company: z.object({
    name: z.string().trim().min(2, "Enter your company name.").max(120),
    website: z.string().trim().max(200).optional().or(z.literal("")),
    industry: z.string().trim().min(2, "Enter your industry or trade.").max(100),
    serviceArea: z.string().trim().min(2, "Enter your service area.").max(160),
    averageJobValue: z.coerce.number().positive("Average job value must be greater than zero.").max(10_000_000).optional().nullable(),
  }),
  leadSources: z.object({
    sources: z.array(z.enum(sourceValues)).min(1, "Pick at least one place your old leads live."),
    estimatedDormantLeads: z.coerce.number().int().nonnegative().max(1_000_000).optional().nullable(),
    notes: z.string().trim().max(1000).optional().or(z.literal("")),
  }),
  campaignPreferences: z.object({
    channels: z.array(z.enum(channelValues)).min(1, "Pick at least one outreach channel."),
    tone: z.enum(toneValues),
    approveBeforeSending: z.boolean(),
  }),
  confirmations: z.object({
    ownsData: z.literal(true, { errorMap: () => ({ message: "This confirmation is required." }) }),
    hasContactPermission: z.literal(true, { errorMap: () => ({ message: "This confirmation is required." }) }),
    honorsOptOuts: z.literal(true, { errorMap: () => ({ message: "This confirmation is required." }) }),
  }),
});

export type RescueIntakeInput = z.infer<typeof rescueIntakeSchema>;
