import { z } from "zod";

export const rescueInputSchema = z.object({
  businessName: z.string().min(2).max(100),
  website: z.string().url(),
  industry: z.string().min(2).max(100),
  serviceArea: z.string().min(2).max(120),
  averageJobValue: z.coerce.number().positive().max(10_000_000),
  monthlyLeadVolume: z.coerce.number().int().nonnegative().max(1_000_000),
  followUpProcess: z.string().min(5).max(1000),
  biggestChallenge: z.string().min(5).max(1000),
});

export type RescueInput = z.infer<typeof rescueInputSchema>;

