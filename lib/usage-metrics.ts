/**
 * Usage metering vocabulary + pure limit/warning/gate math.
 *
 * Pure module (no server imports) so the rollup/threshold/gate logic is
 * directly unit-testable. Server-side recording lives in lib/usage.ts.
 */

export const USAGE_METRICS = [
  "leads_stored",
  "leads_imported",
  "leads_analyzed",
  "ai_jobs",
  "messages_generated",
  "sms_sent",
  "emails_sent",
  "api_requests",
  "webhook_events",
  "active_users",
] as const;

export type UsageMetric = (typeof USAGE_METRICS)[number];

export const USAGE_METRIC_LABELS: Record<UsageMetric, string> = {
  leads_stored: "Stored leads",
  leads_imported: "Leads imported",
  leads_analyzed: "Leads analyzed",
  ai_jobs: "AI jobs",
  messages_generated: "Messages generated",
  sms_sent: "SMS sent (incl. simulated)",
  emails_sent: "Emails sent (incl. simulated)",
  api_requests: "API requests",
  webhook_events: "Webhook events",
  active_users: "Active users",
};

export function isUsageMetric(value: string): value is UsageMetric {
  return (USAGE_METRICS as readonly string[]).includes(value);
}

/** Metrics recorded as per-period counters. leads_stored is a live gauge (count of stored leads). */
export const COUNTER_METRICS = USAGE_METRICS.filter((m) => m !== "leads_stored") as UsageMetric[];

/** Billing period key for a date: "YYYY-MM" (UTC). */
export function usagePeriodFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export type LimitKey = UsageMetric | "seats";

/** A set of limits keyed by metric (plus seats). An absent/null key = unlimited. */
export type LimitSet = Partial<Record<LimitKey, number>>;

/** Legacy limit keys (written by provisioning into organizations.usage_limits). */
const LEGACY_LIMIT_KEYS: Record<string, LimitKey> = {
  leads_per_month: "leads_imported",
  ai_analyses_per_month: "ai_jobs",
  sms_per_month: "sms_sent",
  emails_per_month: "emails_sent",
};

/** Normalizes a raw limits object: maps legacy keys, keeps only known keys with finite non-negative numbers. */
export function normalizeLimits(raw: Record<string, unknown> | null | undefined): LimitSet {
  const out: LimitSet = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key: LimitKey | undefined =
      rawKey === "seats" || isUsageMetric(rawKey) ? (rawKey as LimitKey) : LEGACY_LIMIT_KEYS[rawKey];
    if (!key) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0) continue;
    out[key] = Math.floor(value);
  }
  return out;
}

/** Effective limits: plan limits overlaid by org-specific admin overrides (override wins per key). */
export function effectiveLimits(planLimits: LimitSet, overrides: LimitSet): LimitSet {
  return { ...planLimits, ...overrides };
}

export const WARNING_THRESHOLDS = [75, 90, 100] as const;
export type WarningThreshold = (typeof WARNING_THRESHOLDS)[number];

/** Percent of the limit used (0+), or null when unlimited. */
export function usagePercent(used: number, limit: number | null | undefined): number | null {
  if (limit === null || limit === undefined) return null;
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.floor((used / limit) * 100);
}

/** Highest warning threshold reached (75 | 90 | 100), or null when none/unlimited. */
export function warningLevel(used: number, limit: number | null | undefined): WarningThreshold | null {
  const pct = usagePercent(used, limit);
  if (pct === null) return null;
  let level: WarningThreshold | null = null;
  for (const threshold of WARNING_THRESHOLDS) {
    if (pct >= threshold) level = threshold;
  }
  return level;
}

/** Thresholds newly crossed when a counter moves from `previous` to `current`. */
export function crossedThresholds(previous: number, current: number, limit: number | null | undefined): WarningThreshold[] {
  const prevPct = usagePercent(previous, limit);
  const currPct = usagePercent(current, limit);
  if (prevPct === null || currPct === null) return [];
  return WARNING_THRESHOLDS.filter((t) => prevPct < t && currPct >= t);
}

export type GateDecision = {
  allowed: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
};

/**
 * Server-side usage gate: performing an action that adds `quantity` must stay
 * within the limit. No limit configured = always allowed.
 */
export function evaluateGate(used: number, limit: number | null | undefined, quantity: number): GateDecision {
  if (limit === null || limit === undefined) {
    return { allowed: true, used, limit: null, remaining: null };
  }
  const remaining = Math.max(0, limit - used);
  return { allowed: used + quantity <= limit, used, limit, remaining };
}

// ---------------------------------------------------------------------------
// Subscription / account states
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "suspended", "internal", "cancelled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  trialing: "Trial",
  active: "Active",
  past_due: "Past due",
  suspended: "Suspended",
  internal: "Internal",
  cancelled: "Cancelled",
};

export function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether the account state blocks gated actions outright (usage limits aside).
 * Suspended/cancelled accounts and expired trials are blocked; internal
 * accounts are never blocked. Opt-out processing, suppression updates, and
 * account-closure exports are NEVER routed through this check.
 */
export function accountBlocksGatedActions(
  status: SubscriptionStatus,
  trialEndsAt: string | null,
  now: Date,
): { blocked: boolean; reason: string | null } {
  if (status === "suspended") return { blocked: true, reason: "This account is suspended. Contact support to restore access." };
  if (status === "cancelled") return { blocked: true, reason: "This subscription has been cancelled. Contact support to reactivate." };
  if (status === "trialing" && trialEndsAt && new Date(trialEndsAt).getTime() < now.getTime()) {
    return { blocked: true, reason: "The trial period has ended. Choose a plan to continue." };
  }
  return { blocked: false, reason: null };
}

/** Internal accounts are exempt from usage limits (usage is still recorded). */
export function isLimitExempt(status: SubscriptionStatus): boolean {
  return status === "internal";
}
