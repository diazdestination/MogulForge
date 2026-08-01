import "server-only";
import { getPool } from "./db";
import { ApiError } from "./api-guard";
import { getCommercialState, type CommercialState } from "./subscriptions";
import {
  COUNTER_METRICS,
  USAGE_METRICS,
  USAGE_METRIC_LABELS,
  crossedThresholds,
  evaluateGate,
  usagePeriodFor,
  warningLevel,
  type UsageMetric,
  type WarningThreshold,
} from "./usage-metrics";

/**
 * Usage metering service. Called from import/analysis/messaging/API/webhook
 * paths; writes per-org per-period counters with single-row upserts.
 *
 * NEVER-BLOCK GUARANTEE: opt-out processing, suppression updates, and
 * account-closure exports must never call requireActionCapacity. Recording
 * functions are also best-effort — a metering failure never fails the action.
 */

/** Increments a usage counter and persists any newly crossed 75/90/100% warnings. */
export async function recordUsage(organizationId: string, metric: UsageMetric, quantity = 1, at: Date = new Date()): Promise<void> {
  if (quantity <= 0) return;
  const period = usagePeriodFor(at);
  const { rows } = await getPool().query(
    `INSERT INTO usage_records (organization_id, period, metric, quantity) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, period, metric)
     DO UPDATE SET quantity = usage_records.quantity + EXCLUDED.quantity, updated_at = now()
     RETURNING quantity`,
    [organizationId, period, metric, quantity],
  );
  const current = Number(rows[0]?.quantity ?? quantity);
  await persistCrossedWarnings(organizationId, period, metric, current - quantity, current).catch(() => {});
}

/** Fire-and-forget variant for hot paths (API auth, webhooks, page loads). */
export function recordUsageInBackground(organizationId: string, metric: UsageMetric, quantity = 1): void {
  void recordUsage(organizationId, metric, quantity).catch((error) => {
    console.error("Usage recording failed", organizationId, metric, error);
  });
}

/** Records a distinct active user for the period (mirrors into the active_users counter). */
export async function recordActiveUser(organizationId: string, userId: string, at: Date = new Date()): Promise<void> {
  const period = usagePeriodFor(at);
  const { rowCount } = await getPool().query(
    `INSERT INTO usage_active_users (organization_id, period, user_id) VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, period, user_id) DO NOTHING`,
    [organizationId, period, userId],
  );
  if ((rowCount ?? 0) > 0) await recordUsage(organizationId, "active_users", 1, at);
}

export function recordActiveUserInBackground(organizationId: string, userId: string): void {
  void recordActiveUser(organizationId, userId).catch(() => {});
}

async function persistCrossedWarnings(
  organizationId: string,
  period: string,
  metric: UsageMetric,
  previous: number,
  current: number,
): Promise<void> {
  const state = await getCommercialState(organizationId);
  if (!state || state.limitExempt) return;
  const limit = state.limits[metric];
  const crossed = crossedThresholds(previous, current, limit ?? null);
  for (const threshold of crossed) {
    await getPool().query(
      `INSERT INTO usage_warnings (organization_id, period, metric, threshold) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [organizationId, period, metric, threshold],
    );
  }
}

/** Current usage per metric for one org + period (counters + the stored-leads gauge). */
export async function getUsageCounts(organizationId: string, period: string): Promise<Record<UsageMetric, number>> {
  const [counters, stored] = await Promise.all([
    getPool().query("SELECT metric, quantity FROM usage_records WHERE organization_id = $1 AND period = $2", [organizationId, period]),
    getPool().query("SELECT count(*)::bigint AS n FROM rescue_leads WHERE organization_id = $1", [organizationId]),
  ]);
  const counts = Object.fromEntries(USAGE_METRICS.map((m) => [m, 0])) as Record<UsageMetric, number>;
  for (const row of counters.rows) {
    if ((USAGE_METRICS as readonly string[]).includes(row.metric)) counts[row.metric as UsageMetric] = Number(row.quantity);
  }
  counts.leads_stored = Number(stored.rows[0]?.n ?? 0);
  return counts;
}

export type UsageStatusLine = {
  metric: UsageMetric;
  label: string;
  used: number;
  limit: number | null;
  warning: WarningThreshold | null;
};

export type UsageStatus = {
  period: string;
  plan: { id: string; name: string };
  status: CommercialState["status"];
  trialEndsAt: string | null;
  limitExempt: boolean;
  gateBlock: { blocked: boolean; reason: string | null };
  lines: UsageStatusLine[];
  /** Lines currently at/over a 75/90/100% threshold — the dashboard/admin warning surface. */
  warnings: UsageStatusLine[];
};

/** Full usage + limits + warning picture for one org (dashboard + admin). */
export async function getUsageStatus(organizationId: string, at: Date = new Date()): Promise<UsageStatus | null> {
  const period = usagePeriodFor(at);
  const [state, counts] = await Promise.all([getCommercialState(organizationId, at), getUsageCounts(organizationId, period)]);
  if (!state) return null;
  const lines: UsageStatusLine[] = USAGE_METRICS.map((metric) => {
    const limit = state.limitExempt ? null : (state.limits[metric] ?? null);
    return {
      metric,
      label: USAGE_METRIC_LABELS[metric],
      used: counts[metric],
      limit,
      warning: warningLevel(counts[metric], limit),
    };
  });
  return {
    period,
    plan: { id: state.planId, name: state.planName },
    status: state.status,
    trialEndsAt: state.trialEndsAt,
    limitExempt: state.limitExempt,
    gateBlock: state.gateBlock,
    lines,
    warnings: lines.filter((line) => line.warning !== null),
  };
}

export type OrgUsageRow = {
  organizationId: string;
  name: string;
  planId: string;
  planName: string;
  status: string;
  counts: Record<UsageMetric, number>;
  warnings: { metric: UsageMetric; threshold: number }[];
};

/** Cross-organization consumption for the platform admin console (/admin/usage). */
export async function getAllOrgUsage(period: string): Promise<OrgUsageRow[]> {
  const { rows } = await getPool().query(
    `SELECT o.id, o.name, o.plan AS legacy_plan,
            s.plan_id, s.status AS sub_status,
            COALESCE(p.name, lp.name, o.plan) AS plan_name,
            (SELECT count(*)::bigint FROM rescue_leads rl WHERE rl.organization_id = o.id) AS leads_stored,
            COALESCE(u.metrics, '{}'::jsonb) AS metrics,
            COALESCE(w.warnings, '[]'::jsonb) AS warnings
     FROM organizations o
     LEFT JOIN org_subscriptions s ON s.organization_id = o.id
     LEFT JOIN plan_definitions p ON p.id = s.plan_id
     LEFT JOIN plan_definitions lp ON lp.id = o.plan
     LEFT JOIN LATERAL (
       SELECT jsonb_object_agg(ur.metric, ur.quantity) AS metrics
       FROM usage_records ur WHERE ur.organization_id = o.id AND ur.period = $1
     ) u ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('metric', uw.metric, 'threshold', uw.threshold) ORDER BY uw.threshold DESC) AS warnings
       FROM usage_warnings uw WHERE uw.organization_id = o.id AND uw.period = $1
     ) w ON true
     ORDER BY o.name ASC`,
    [period],
  );
  return rows.map((row) => {
    const counts = Object.fromEntries(USAGE_METRICS.map((m) => [m, 0])) as Record<UsageMetric, number>;
    for (const [metric, quantity] of Object.entries(row.metrics ?? {})) {
      if ((USAGE_METRICS as readonly string[]).includes(metric)) counts[metric as UsageMetric] = Number(quantity);
    }
    counts.leads_stored = Number(row.leads_stored ?? 0);
    return {
      organizationId: row.id,
      name: row.name,
      planId: row.plan_id ?? row.legacy_plan,
      planName: row.plan_name,
      status: row.sub_status ?? "active",
      counts,
      warnings: (row.warnings ?? []) as { metric: UsageMetric; threshold: number }[],
    };
  });
}

/** Current counter value for a metric (leads_stored reads the live gauge). */
async function currentMetricValue(organizationId: string, metric: UsageMetric, period: string): Promise<number> {
  if (metric === "leads_stored") {
    const { rows } = await getPool().query("SELECT count(*)::bigint AS n FROM rescue_leads WHERE organization_id = $1", [organizationId]);
    return Number(rows[0]?.n ?? 0);
  }
  const { rows } = await getPool().query(
    "SELECT quantity FROM usage_records WHERE organization_id = $1 AND period = $2 AND metric = $3",
    [organizationId, period, metric],
  );
  return Number(rows[0]?.quantity ?? 0);
}

/**
 * Server-side gate for metered actions (imports, analysis, campaign sends,
 * API/webhook lead creation). Throws a clear ApiError when the account state
 * blocks gated actions or the plan limit would be exceeded.
 *
 * MUST NOT be called on: opt-out processing, suppression updates, or
 * account-closure exports — those always run, regardless of limits or state.
 */
export async function requireActionCapacity(
  organizationId: string,
  checks: Partial<Record<UsageMetric, number>>,
  at: Date = new Date(),
): Promise<void> {
  const state = await getCommercialState(organizationId, at);
  if (!state) return; // org missing — membership checks handle that
  if (state.gateBlock.blocked) throw new ApiError(403, state.gateBlock.reason ?? "This account cannot perform this action.", "account_blocked");
  if (state.limitExempt) return;
  const period = usagePeriodFor(at);
  for (const [metric, quantity] of Object.entries(checks) as [UsageMetric, number][]) {
    const limit = state.limits[metric];
    if (limit === undefined) continue;
    const used = await currentMetricValue(organizationId, metric, period);
    const gate = evaluateGate(used, limit, quantity);
    if (!gate.allowed) {
      throw new ApiError(
        403,
        `${USAGE_METRIC_LABELS[metric]} limit reached for the ${state.planName} plan (${used.toLocaleString()} of ${limit.toLocaleString()} used this period${quantity > 1 ? `; this action needs ${quantity.toLocaleString()} more` : ""}). Upgrade the plan or contact support. Opt-out processing and suppression updates are never blocked.`,
        "usage_limit_reached",
      );
    }
  }
}

/** Non-throwing gate check (used by paths that report instead of erroring). */
export async function checkActionCapacity(
  organizationId: string,
  checks: Partial<Record<UsageMetric, number>>,
): Promise<{ allowed: boolean; reason: string | null }> {
  try {
    await requireActionCapacity(organizationId, checks);
    return { allowed: true, reason: null };
  } catch (error) {
    if (error instanceof ApiError) return { allowed: false, reason: error.message };
    throw error;
  }
}

export { COUNTER_METRICS };
