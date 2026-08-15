import { z } from "zod";

export const growthOSInterestSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name.").max(120),
  workEmail: z.string().trim().email("Enter a valid work email.").max(254),
  company: z.string().trim().min(2, "Enter your company name.").max(160),
  website: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((value) => value || undefined),
  phone: z
    .string()
    .trim()
    .max(40)
    .optional()
    .transform((value) => value || undefined),
  priority: z.enum([
    "recover-cold-leads",
    "pipeline-follow-up",
    "email-intelligence",
    "connect-business-data",
    "replace-or-connect-crm",
    "other",
  ]),
  monthlyLeads: z.coerce.number().int().nonnegative().max(1_000_000).optional(),
  notes: z.string().trim().max(2_000).optional(),
  consent: z.literal(true, {
    errorMap: () => ({ message: "Confirm that MogulForge may contact you about the beta." }),
  }),
  companyFax: z.string().max(0).optional(),
});

export type GrowthOSInterestInput = z.infer<typeof growthOSInterestSchema>;

export const growthOSPriorityLabels: Record<GrowthOSInterestInput["priority"], string> = {
  "recover-cold-leads": "Recover cold or stalled leads",
  "pipeline-follow-up": "Improve pipeline and follow-up",
  "email-intelligence": "Find opportunities in business email",
  "connect-business-data": "Connect business data and evidence",
  "replace-or-connect-crm": "Connect or replace an existing CRM",
  other: "Something else",
};
