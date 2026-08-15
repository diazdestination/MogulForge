import { z } from "zod";

export const rescueInputSchema = z.object({
  businessName: z.string().trim().min(2, "Enter your business name.").max(100),
  website: z.string().trim().min(3, "Enter your website.")
    .transform((value) => /^https?:\/\//i.test(value) ? value : `https://${value}`)
    .pipe(z.string().url("Enter a valid website, such as example.com.")),
  industry: z.string().trim().min(1, "Enter your industry.").max(100),
  serviceArea: z.string().trim().min(1, "Enter your service area.").max(120),
  averageJobValue: z.coerce.number().positive("Average job value must be greater than zero.").max(10_000_000),
  monthlyLeadVolume: z.coerce.number().int("Use a whole number for monthly leads.").nonnegative("Monthly leads cannot be negative.").max(1_000_000),
  followUpProcess: z.string().trim().min(1, "Describe your current follow-up, even if it is ‘none’. ").max(1000),
  biggestChallenge: z.string().trim().min(1, "Describe your biggest sales challenge.").max(1000),
});

export type RescueInput = z.infer<typeof rescueInputSchema>;
