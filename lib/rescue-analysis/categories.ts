/** Lead analysis categories from the Revenue Rescue spec. Pure module. */

export const LEAD_CATEGORIES = [
  "hot_opportunity",
  "worth_reengaging",
  "long_term_nurture",
  "needs_manual_review",
  "invalid_duplicate",
  "do_not_contact",
  "previously_lost",
  "existing_customer",
  "no_longer_qualified",
] as const;

export type LeadCategory = (typeof LEAD_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<LeadCategory, string> = {
  hot_opportunity: "Hot opportunity",
  worth_reengaging: "Worth re-engaging",
  long_term_nurture: "Long-term nurture",
  needs_manual_review: "Needs manual review",
  invalid_duplicate: "Invalid / duplicate",
  do_not_contact: "Do not contact",
  previously_lost: "Previously lost",
  existing_customer: "Existing customer",
  no_longer_qualified: "No longer qualified",
};

export function isLeadCategory(value: string): value is LeadCategory {
  return (LEAD_CATEGORIES as readonly string[]).includes(value);
}

/** Categories that must never receive outreach regardless of score or AI output. */
export const NO_OUTREACH_CATEGORIES: LeadCategory[] = ["do_not_contact", "invalid_duplicate"];

/** Per-lead analysis lifecycle (rescue_leads.analysis_status). */
export const ANALYSIS_STATUSES = ["pending", "analyzing", "analyzed", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
