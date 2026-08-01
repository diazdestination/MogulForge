import type { FeatureKey } from "./entitlements";

export const PLANS = ["starter", "growth", "scale", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_LABELS: Record<Plan, string> = {
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
  enterprise: "Enterprise",
};

export type UsageLimits = {
  seats: number;
  leads_per_month: number;
  ai_analyses_per_month: number;
  sms_per_month: number;
  emails_per_month: number;
};

/** Default module set + usage limits per plan. Admin can override at provisioning time. */
export const PLAN_DEFAULTS: Record<Plan, { modules: FeatureKey[]; limits: UsageLimits }> = {
  starter: {
    modules: ["revenue_rescue", "lead_import", "analytics"],
    limits: { seats: 3, leads_per_month: 500, ai_analyses_per_month: 0, sms_per_month: 0, emails_per_month: 2000 },
  },
  growth: {
    modules: ["revenue_rescue", "lead_import", "ai_analysis", "email_campaigns", "analytics"],
    limits: { seats: 10, leads_per_month: 2500, ai_analyses_per_month: 2500, sms_per_month: 0, emails_per_month: 10000 },
  },
  scale: {
    modules: ["revenue_rescue", "lead_import", "ai_analysis", "sms_campaigns", "email_campaigns", "appointments", "analytics"],
    limits: { seats: 25, leads_per_month: 10000, ai_analyses_per_month: 10000, sms_per_month: 5000, emails_per_month: 50000 },
  },
  enterprise: {
    modules: ["revenue_rescue", "lead_import", "ai_analysis", "sms_campaigns", "email_campaigns", "appointments", "analytics", "api_access"],
    limits: { seats: 100, leads_per_month: 100000, ai_analyses_per_month: 100000, sms_per_month: 50000, emails_per_month: 500000 },
  },
};

export function isPlan(value: string): value is Plan {
  return (PLANS as readonly string[]).includes(value);
}

export const ORG_STATUSES = ["active", "paused", "cancelled"] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];
