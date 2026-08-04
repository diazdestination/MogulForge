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

// Why a trap fired, for over-blocking monitoring. Never includes any of the
// submission's data — only the trigger category.
export type BotTrapReason = "honeypot" | "missing_elapsed" | "too_fast";

export function botSubmissionReason(body: unknown): BotTrapReason | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.website === "string" && record.website.trim() !== "") return "honeypot";
  if (typeof record.elapsedMs !== "number" || !Number.isFinite(record.elapsedMs)) return "missing_elapsed";
  return record.elapsedMs < MIN_SUBMIT_MS ? "too_fast" : null;
}

export function isBotSubmission(body: unknown): boolean {
  return botSubmissionReason(body) !== null;
}

export type CategoryScore = { name: string; score: number; findings: string[] };
export type VisibilityReport = {
  score: number;
  categories: CategoryScore[];
  recommendations: { title: string; why: string; fix: string }[];
  summary: string;
};
