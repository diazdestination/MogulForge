import "server-only";
import { getPool } from "./db";
import { PLAN_DEFAULTS, isPlan } from "./plans";
import {
  accountBlocksGatedActions,
  effectiveLimits,
  isLimitExempt,
  isSubscriptionStatus,
  normalizeLimits,
  type LimitSet,
  type SubscriptionStatus,
} from "./usage-metrics";

/**
 * Plan definitions (admin-editable pricing + limits) and org subscriptions
 * (plan assignment, trial/suspended/internal states, billing adapter linkage).
 */

export type PlanDefinition = {
  id: string;
  name: string;
  blurb: string;
  price: number;
  cadence: "per month" | "one-time";
  features: string[];
  limits: LimitSet;
  featured: boolean;
  isPublic: boolean;
  sortOrder: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapPlan(row: any): PlanDefinition {
  return {
    id: row.id,
    name: row.name,
    blurb: row.blurb ?? "",
    price: Number(row.price),
    cadence: row.cadence === "one-time" ? "one-time" : "per month",
    features: Array.isArray(row.features) ? row.features.map(String) : [],
    limits: normalizeLimits(row.limits ?? {}),
    featured: !!row.featured,
    isPublic: !!row.is_public,
    sortOrder: Number(row.sort_order ?? 0),
  };
}

export async function listPlanDefinitions(): Promise<PlanDefinition[]> {
  const { rows } = await getPool().query("SELECT * FROM plan_definitions ORDER BY sort_order ASC, price ASC");
  return rows.map(mapPlan);
}

/** Public plans power the pricing cards on /revenue-rescue. */
export async function listPublicPlans(): Promise<PlanDefinition[]> {
  const { rows } = await getPool().query(
    "SELECT * FROM plan_definitions WHERE is_public = true ORDER BY sort_order ASC, price ASC",
  );
  return rows.map(mapPlan);
}

export async function getPlanDefinition(id: string): Promise<PlanDefinition | null> {
  const { rows } = await getPool().query("SELECT * FROM plan_definitions WHERE id = $1", [id]);
  return rows[0] ? mapPlan(rows[0]) : null;
}

export async function upsertPlanDefinition(input: {
  id: string;
  name: string;
  blurb: string;
  price: number;
  cadence: "per month" | "one-time";
  features: string[];
  limits: LimitSet;
  featured: boolean;
  isPublic: boolean;
  sortOrder: number;
}): Promise<PlanDefinition> {
  const { rows } = await getPool().query(
    `INSERT INTO plan_definitions (id, name, blurb, price, cadence, features, limits, featured, is_public, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name, blurb = EXCLUDED.blurb, price = EXCLUDED.price, cadence = EXCLUDED.cadence,
       features = EXCLUDED.features, limits = EXCLUDED.limits, featured = EXCLUDED.featured,
       is_public = EXCLUDED.is_public, sort_order = EXCLUDED.sort_order, updated_at = now()
     RETURNING *`,
    [
      input.id,
      input.name,
      input.blurb,
      input.price,
      input.cadence,
      JSON.stringify(input.features),
      JSON.stringify(input.limits),
      input.featured,
      input.isPublic,
      input.sortOrder,
    ],
  );
  return mapPlan(rows[0]);
}

export type OrgSubscription = {
  organizationId: string;
  planId: string;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  billingProvider: string;
  billingRef: string | null;
  notes: string | null;
  updatedAt: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapSubscription(row: any): OrgSubscription {
  return {
    organizationId: row.organization_id,
    planId: row.plan_id,
    status: isSubscriptionStatus(row.status) ? row.status : "active",
    trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
    billingProvider: row.billing_provider ?? "manual",
    billingRef: row.billing_ref ?? null,
    notes: row.notes ?? null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function getOrgSubscription(organizationId: string): Promise<OrgSubscription | null> {
  const { rows } = await getPool().query("SELECT * FROM org_subscriptions WHERE organization_id = $1", [organizationId]);
  return rows[0] ? mapSubscription(rows[0]) : null;
}

/** Upserts the org's subscription (plan upgrades/downgrades + account states). */
export async function setOrgSubscription(
  organizationId: string,
  input: {
    planId: string;
    status: SubscriptionStatus;
    trialEndsAt?: string | null;
    billingProvider?: string;
    billingRef?: string | null;
    notes?: string | null;
  },
): Promise<OrgSubscription> {
  const plan = await getPlanDefinition(input.planId);
  if (!plan) throw new Error(`Unknown plan: ${input.planId}`);
  const { rows } = await getPool().query(
    `INSERT INTO org_subscriptions (organization_id, plan_id, status, trial_ends_at, billing_provider, billing_ref, notes)
     VALUES ($1, $2, $3, $4, COALESCE($5, 'manual'), $6, $7)
     ON CONFLICT (organization_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, trial_ends_at = EXCLUDED.trial_ends_at,
       billing_provider = COALESCE($5, org_subscriptions.billing_provider),
       billing_ref = COALESCE($6, org_subscriptions.billing_ref),
       notes = EXCLUDED.notes, updated_at = now()
     RETURNING *`,
    [organizationId, input.planId, input.status, input.trialEndsAt ?? null, input.billingProvider ?? null, input.billingRef ?? null, input.notes ?? null],
  );
  return mapSubscription(rows[0]);
}

export type CommercialState = {
  planId: string;
  planName: string;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  billingProvider: string;
  /** Effective limits: plan limits overlaid by the org's admin overrides. */
  limits: LimitSet;
  /** Internal accounts are exempt from usage limits (usage still recorded). */
  limitExempt: boolean;
  gateBlock: { blocked: boolean; reason: string | null };
  hasSubscriptionRow: boolean;
};

/**
 * Resolves the commercial state for an org in one query: subscription row
 * (falling back to the org's legacy plan column), plan limits, and org-level
 * limit overrides (organizations.usage_limits — the admin override layer).
 */
export async function getCommercialState(organizationId: string, now: Date = new Date()): Promise<CommercialState | null> {
  const { rows } = await getPool().query(
    `SELECT o.plan AS legacy_plan, o.usage_limits AS overrides,
            s.plan_id, s.status, s.trial_ends_at, s.billing_provider,
            p.name AS plan_name, p.limits AS plan_limits,
            lp.name AS legacy_plan_name, lp.limits AS legacy_plan_limits
     FROM organizations o
     LEFT JOIN org_subscriptions s ON s.organization_id = o.id
     LEFT JOIN plan_definitions p ON p.id = s.plan_id
     LEFT JOIN plan_definitions lp ON lp.id = o.plan
     WHERE o.id = $1`,
    [organizationId],
  );
  const row = rows[0];
  if (!row) return null;

  const hasSubscriptionRow = !!row.plan_id;
  const planId: string = row.plan_id ?? row.legacy_plan;
  const planName: string = row.plan_name ?? row.legacy_plan_name ?? planId;
  const status: SubscriptionStatus = hasSubscriptionRow && isSubscriptionStatus(row.status) ? row.status : "active";
  const trialEndsAt: string | null = row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null;

  let planLimits = normalizeLimits(row.plan_limits ?? row.legacy_plan_limits ?? null);
  if (Object.keys(planLimits).length === 0 && !row.plan_limits && !row.legacy_plan_limits && isPlan(planId)) {
    planLimits = normalizeLimits(PLAN_DEFAULTS[planId].limits as unknown as Record<string, unknown>);
  }
  const overrides = normalizeLimits(row.overrides ?? null);

  return {
    planId,
    planName,
    status,
    trialEndsAt,
    billingProvider: row.billing_provider ?? "manual",
    limits: effectiveLimits(planLimits, overrides),
    limitExempt: isLimitExempt(status),
    gateBlock: accountBlocksGatedActions(status, trialEndsAt, now),
    hasSubscriptionRow,
  };
}
