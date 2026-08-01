/** The eight campaign templates from the Revenue Rescue spec. Pure module. */
import type { LeadCategory } from "../rescue-analysis/categories.ts";
import type { CampaignChannel, CampaignTone } from "./campaign-schema.ts";

export type CampaignTemplate = {
  key: string;
  name: string;
  description: string;
  objective: string;
  channel: CampaignChannel;
  tone: CampaignTone;
  audience: { categories: LeadCategory[]; minScore: number | null };
};

export const CAMPAIGN_TEMPLATES: CampaignTemplate[] = [
  {
    key: "old_estimate_follow_up",
    name: "Old Estimate Follow-Up",
    description: "Re-open conversations with people who received an estimate but never moved forward.",
    objective: "Follow up on the estimate we prepared and find out where the project stands.",
    channel: "sms",
    tone: "professional",
    audience: { categories: ["hot_opportunity", "worth_reengaging"], minScore: 50 },
  },
  {
    key: "delayed_project_check_in",
    name: "Delayed Project Check-In",
    description: "Check in with homeowners whose projects were postponed rather than rejected.",
    objective: "Check whether the delayed project is back on their list and offer to pick it up.",
    channel: "email",
    tone: "friendly",
    audience: { categories: ["worth_reengaging", "long_term_nurture"], minScore: 40 },
  },
  {
    key: "missed_website_inquiry",
    name: "Missed Website Inquiry",
    description: "Recover website leads that never got a timely response.",
    objective: "Apologize for the slow response and restart the conversation about their inquiry.",
    channel: "email",
    tone: "friendly",
    audience: { categories: ["hot_opportunity", "worth_reengaging"], minScore: 40 },
  },
  {
    key: "seasonal_inspection",
    name: "Seasonal Inspection",
    description: "Offer a seasonal check-up to dormant contacts and past inquirers.",
    objective: "Offer a seasonal inspection as a low-pressure reason to reconnect.",
    channel: "email",
    tone: "professional",
    audience: { categories: ["long_term_nurture", "worth_reengaging"], minScore: null },
  },
  {
    key: "proposal_revisit",
    name: "Proposal Revisit",
    description: "Revisit unsold proposals with a fresh set of eyes and current availability.",
    objective: "Reopen the unsold proposal and offer to review updated options or pricing.",
    channel: "email",
    tone: "professional",
    audience: { categories: ["hot_opportunity", "worth_reengaging"], minScore: 55 },
  },
  {
    key: "previous_customer_upsell",
    name: "Previous Customer Upsell",
    description: "Reach existing customers with a relevant next project or maintenance offer.",
    objective: "Check in with past customers about maintenance or a next project.",
    channel: "email",
    tone: "friendly",
    audience: { categories: ["existing_customer"], minScore: null },
  },
  {
    key: "missed_call_recovery",
    name: "Missed Call Recovery",
    description: "Text back missed callers who never got a follow-up.",
    objective: "Acknowledge the missed call and make it easy to restart the conversation by text.",
    channel: "sms",
    tone: "friendly",
    audience: { categories: ["hot_opportunity", "worth_reengaging"], minScore: 40 },
  },
  {
    key: "long_term_nurture_restart",
    name: "Long-Term Nurture Restart",
    description: "Gently restart contact with long-dormant leads worth keeping warm.",
    objective: "Re-introduce the company and invite a low-commitment reply about future plans.",
    channel: "email",
    tone: "friendly",
    audience: { categories: ["long_term_nurture"], minScore: null },
  },
];

export function getCampaignTemplate(key: string): CampaignTemplate | null {
  return CAMPAIGN_TEMPLATES.find((t) => t.key === key) ?? null;
}
