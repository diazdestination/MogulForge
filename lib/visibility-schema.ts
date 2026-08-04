import { z } from "zod";

export const visibilityInputSchema = z.object({
  url: z.string().trim().min(3, "Enter your website.")
    .transform((value) => /^https?:\/\//i.test(value) ? value : `https://${value}`)
    .pipe(z.string().url("Enter a valid website, such as example.com.")),
  email: z.string({ required_error: "Enter your email so we can send your report." }).trim().email("Enter a valid email so we can send your report.").max(200),
});

export type VisibilityInput = z.infer<typeof visibilityInputSchema>;

// Bot-trap check on the raw request body, before validation or any spend.
// `website` is a honeypot field hidden from humans; `elapsedMs` is the
// client-measured time from form mount to submit. Naive bots either fill the
// honeypot, omit elapsedMs, or submit near-instantly.
export const MIN_SUBMIT_MS = 2000;

export function isBotSubmission(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  if (typeof record.website === "string" && record.website.trim() !== "") return true;
  if (typeof record.elapsedMs !== "number" || !Number.isFinite(record.elapsedMs)) return true;
  return record.elapsedMs < MIN_SUBMIT_MS;
}

export type CategoryScore = { name: string; score: number; findings: string[] };
export type VisibilityReport = {
  score: number;
  categories: CategoryScore[];
  recommendations: { title: string; why: string; fix: string }[];
  summary: string;
};
