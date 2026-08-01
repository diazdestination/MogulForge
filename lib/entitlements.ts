/** Feature entitlement keys. Enforced server-side via requireEntitlement — never by hiding UI. */
export const FEATURE_KEYS = [
  "revenue_rescue",
  "lead_import",
  "ai_analysis",
  "sms_campaigns",
  "email_campaigns",
  "appointments",
  "analytics",
  "api_access",
  "white_label",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  revenue_rescue: "Revenue Rescue",
  lead_import: "Lead Import",
  ai_analysis: "AI Analysis & Scoring",
  sms_campaigns: "SMS Campaigns",
  email_campaigns: "Email Campaigns",
  appointments: "Appointments",
  analytics: "Analytics & Reporting",
  api_access: "Public API Access",
  white_label: "Full White Label",
};

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}
