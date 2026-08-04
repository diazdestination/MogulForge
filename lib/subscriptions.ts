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
  /** Scheduled downgrade target: applied when pendingPlanEffectiveAt passes. */
  pendingPlanId: string | null;
  pendingPlanEffectiveAt: string | null;
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
    pendingPlanId: row.pending_plan_id ?? null,
    pendingPlanEffectiveAt: row.pending_plan_effective_at ? new Date(row.pending_plan_effective_at).toISOString() : null,
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

/** First instant of the next usage period (UTC month start), matching usagePeriodFor. */
export function nextUsagePeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Schedules a downgrade: the plan switch is applied when effectiveAt passes. */
export async function schedulePendingPlanChange(organizationId: string, planId: string, effectiveAt: Date): Promise<OrgSubscription> {
  const { rows } = await getPool().query(
    `UPDATE org_subscriptions
     SET pending_plan_id = $2, pending_plan_effective_at = $3, pending_plan_reminder_sent_at = NULL,
         pending_plan_failed_attempts = 0, pending_plan_failure_alerted_at = NULL, updated_at = now()
     WHERE organization_id = $1
     RETURNING *`,
    [organizationId, planId, effectiveAt.toISOString()],
  );
  if (!rows[0]) throw new Error("Organization has no subscription row to schedule a plan change on.");
  return mapSubscription(rows[0]);
}

/** Cancels a scheduled downgrade. Returns the cleared subscription, or null when none existed. */
export async function clearPendingPlanChange(organizationId: string): Promise<OrgSubscription | null> {
  const { rows } = await getPool().query(
    `UPDATE org_subscriptions
     SET pending_plan_id = NULL, pending_plan_effective_at = NULL, pending_plan_reminder_sent_at = NULL,
         pending_plan_failed_attempts = 0, pending_plan_failure_alerted_at = NULL, updated_at = now()
     WHERE organization_id = $1 AND pending_plan_id IS NOT NULL
     RETURNING *`,
    [organizationId],
  );
  return rows[0] ? mapSubscription(rows[0]) : null;
}

export type AppliedPlanChange = { organizationId: string; fromPlanId: string; toPlanId: string; effectiveAt: string };

/**
 * Applies every scheduled plan change whose effective date has passed and
 * audit-logs each application. Idempotent — applied rows have their pending
 * columns cleared, so re-runs are no-ops. Safe to call from cron, the in-app
 * timer, and lazily from page loads.
 *
 * The org's billing adapter is notified (changePlan) at application time —
 * not at scheduling time. When the provider call fails, the pending change is
 * left intact so the next pass retries it, and the failure is audit-logged.
 */
export async function applyDuePendingPlanChanges(now: Date = new Date(), organizationId?: string): Promise<AppliedPlanChange[]> {
  const pool = getPool();
  const params: unknown[] = [now.toISOString()];
  if (organizationId) params.push(organizationId);
  const { rows: due } = await pool.query(
    `SELECT organization_id
     FROM org_subscriptions
     WHERE pending_plan_id IS NOT NULL AND pending_plan_effective_at <= $1
       ${organizationId ? "AND organization_id = $2" : ""}`,
    params,
  );
  if (due.length === 0) return [];

  const { getBillingAdapter } = await import("./billing");
  const { logAudit } = await import("./audit");
  const applied: AppliedPlanChange[] = [];
  const failures: Array<Record<string, unknown> & { organizationId: string }> = [];

  for (const candidate of due) {
    const client = await pool.connect();
    let change: AppliedPlanChange | null = null;
    try {
      await client.query("BEGIN");
      // Claim the row before contacting the provider: FOR UPDATE SKIP LOCKED
      // guarantees exactly one concurrent runner (cron, in-app timer, lazy
      // page-load pass) processes a given pending change — the others skip it.
      const { rows } = await client.query(
        `SELECT organization_id, plan_id AS from_plan_id, pending_plan_id AS to_plan_id,
                pending_plan_effective_at, billing_provider, billing_ref
         FROM org_subscriptions
         WHERE organization_id = $1 AND pending_plan_id IS NOT NULL AND pending_plan_effective_at <= $2
         FOR UPDATE SKIP LOCKED`,
        [candidate.organization_id, now.toISOString()],
      );
      const row = rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        continue;
      }
      change = {
        organizationId: row.organization_id,
        fromPlanId: row.from_plan_id,
        toPlanId: row.to_plan_id,
        effectiveAt: new Date(row.pending_plan_effective_at).toISOString(),
      };

      // Notify the provider while holding the claim: only a successful
      // provider-side change may clear the pending columns. Failures roll
      // back, keeping the row pending for retry on the next pass.
      const adapter = getBillingAdapter(row.billing_provider);
      let result: { ok: boolean; providerRef: string | null; note: string };
      try {
        result = await adapter.changePlan({
          organizationId: change.organizationId,
          billingRef: row.billing_ref ?? null,
          fromPlanId: change.fromPlanId,
          toPlanId: change.toPlanId,
        });
      } catch (error) {
        result = { ok: false, providerRef: null, note: error instanceof Error ? error.message : String(error) };
      }
      if (!result.ok) {
        await client.query("ROLLBACK");
        failures.push({
          organizationId: change.organizationId,
          planId: change.toPlanId,
          previousPlanId: change.fromPlanId,
          effectiveAt: change.effectiveAt,
          billingProvider: adapter.provider,
          billingNote: result.note,
        });
        continue;
      }

      await client.query(
        `UPDATE org_subscriptions
         SET plan_id = pending_plan_id, pending_plan_id = NULL, pending_plan_effective_at = NULL,
             pending_plan_reminder_sent_at = NULL,
             pending_plan_failed_attempts = 0, pending_plan_failure_alerted_at = NULL,
             billing_ref = COALESCE($2, billing_ref), updated_at = now()
         WHERE organization_id = $1`,
        [change.organizationId, result.providerRef],
      );
      await client.query("COMMIT");
      applied.push(change);
      await logAudit({
        organizationId: change.organizationId,
        actorLabel: "system",
        action: "subscription.scheduled_change_applied",
        targetType: "org_subscription",
        targetId: change.organizationId,
        metadata: {
          planId: change.toPlanId,
          previousPlanId: change.fromPlanId,
          effectiveAt: change.effectiveAt,
          billingProvider: adapter.provider,
          billingNote: result.note,
        },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Failed to apply scheduled plan change", candidate.organization_id, error);
    } finally {
      client.release();
    }
  }

  for (const { organizationId: failedOrgId, ...metadata } of failures) {
    await logAudit({
      organizationId: failedOrgId,
      actorLabel: "system",
      action: "subscription.scheduled_change_failed",
      targetType: "org_subscription",
      targetId: failedOrgId,
      metadata,
    });
    await escalateRepeatedPlanChangeFailure(failedOrgId, metadata).catch((error) => {
      console.error("Plan change failure escalation errored for", failedOrgId, error);
    });
  }
  return applied;
}

/**
 * Counts consecutive failed apply passes for an org's pending change and,
 * once the threshold is hit, alerts platform admins exactly once: the
 * pending_plan_failure_alerted_at claim is taken atomically before sending,
 * and released if delivery throws so the next pass retries the alert. The
 * counter and claim reset whenever the change is (re)scheduled, cancelled,
 * or finally applied.
 */
async function escalateRepeatedPlanChangeFailure(organizationId: string, metadata: Record<string, unknown>): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE org_subscriptions
     SET pending_plan_failed_attempts = pending_plan_failed_attempts + 1, updated_at = now()
     WHERE organization_id = $1 AND pending_plan_id IS NOT NULL
     RETURNING pending_plan_failed_attempts, pending_plan_failure_alerted_at, plan_id, pending_plan_id, pending_plan_effective_at`,
    [organizationId],
  );
  const row = rows[0];
  if (!row) return; // change was cancelled/applied meanwhile

  const { PLAN_CHANGE_FAILURE_ALERT_THRESHOLD, sendPlanChangeFailureAlert } = await import("./plan-change-alerts");
  const attempts = Number(row.pending_plan_failed_attempts);
  if (attempts < PLAN_CHANGE_FAILURE_ALERT_THRESHOLD || row.pending_plan_failure_alerted_at) return;

  // Claim the one-time alert atomically so concurrent passes never double-send.
  const claim = await pool.query(
    `UPDATE org_subscriptions
     SET pending_plan_failure_alerted_at = now()
     WHERE organization_id = $1 AND pending_plan_id IS NOT NULL AND pending_plan_failure_alerted_at IS NULL
     RETURNING organization_id`,
    [organizationId],
  );
  if (claim.rowCount === 0) return;

  const { rows: orgRows } = await pool.query("SELECT name FROM organizations WHERE id = $1", [organizationId]);
  const alert = {
    organizationId,
    organizationName: orgRows[0]?.name ?? organizationId,
    fromPlanId: row.plan_id,
    toPlanId: row.pending_plan_id,
    effectiveAt: new Date(row.pending_plan_effective_at).toISOString(),
    billingProvider: String(metadata.billingProvider ?? "unknown"),
    billingNote: String(metadata.billingNote ?? ""),
    failedAttempts: attempts,
  };
  try {
    const result = await sendPlanChangeFailureAlert(alert);
    const { logAudit } = await import("./audit");
    await logAudit({
      organizationId,
      actorLabel: "system",
      action: result.sent ? "subscription.scheduled_change_failure_alerted" : "subscription.scheduled_change_failure_alert_skipped",
      targetType: "org_subscription",
      targetId: organizationId,
      metadata: { ...alert, ...(result.reason ? { reason: result.reason } : {}) },
    });
  } catch (error) {
    // Delivery failure: release the claim so the next failed pass retries the alert.
    await pool
      .query(
        "UPDATE org_subscriptions SET pending_plan_failure_alerted_at = NULL WHERE organization_id = $1 AND pending_plan_id IS NOT NULL",
        [organizationId],
      )
      .catch(() => {});
    throw error;
  }
}
const REMINDER_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

export type PlanChangeReminderOutcome = { organizationId: string; status: "sent" | "skipped"; reason?: string };

/**
 * Emails org notification recipients ~3 days before a scheduled plan change
 * takes effect. Each pending change gets at most one reminder: the row is
 * claimed by setting pending_plan_reminder_sent_at before sending, and the
 * flag is cleared whenever the change is (re)scheduled, cancelled, or
 * applied. Preference-based skips (toggle off, no recipients) still consume
 * the claim so the pass never re-nags. Delivery failures release the claim
 * for the next pass. Safe to call from cron and the in-app timer.
 */
export async function sendDuePendingPlanChangeReminders(now: Date = new Date()): Promise<PlanChangeReminderOutcome[]> {
  const { rows } = await getPool().query(
    `UPDATE org_subscriptions s
     SET pending_plan_reminder_sent_at = now()
     FROM (
       SELECT sub.organization_id
       FROM org_subscriptions sub
       WHERE sub.pending_plan_id IS NOT NULL
         AND sub.pending_plan_reminder_sent_at IS NULL
         AND sub.pending_plan_effective_at > $1
         AND sub.pending_plan_effective_at <= $2
       FOR UPDATE SKIP LOCKED
     ) due
     WHERE s.organization_id = due.organization_id
     RETURNING s.organization_id, s.pending_plan_id, s.pending_plan_effective_at,
       (SELECT name FROM organizations o WHERE o.id = s.organization_id) AS org_name,
       (SELECT name FROM plan_definitions p WHERE p.id = s.plan_id) AS current_plan_name,
       (SELECT name FROM plan_definitions p WHERE p.id = s.pending_plan_id) AS pending_plan_name`,
    [now.toISOString(), new Date(now.getTime() + REMINDER_LEAD_MS).toISOString()],
  );
  if (rows.length === 0) return [];

  const [{ sendOrgAlert }, { buildPlanChangeReminderEmail }, { getOrgPortalBaseUrl }, { logAudit }] = await Promise.all([
    import("./org-alerts"),
    import("./org-alerts-content"),
    import("./custom-domains"),
    import("./audit"),
  ]);

  const outcomes: PlanChangeReminderOutcome[] = [];
  for (const row of rows) {
    const effectiveAt = new Date(row.pending_plan_effective_at);
    try {
      // Link to the org's branded portal domain when one is active, so the
      // email feels first-party and matches the client's login session.
      const baseUrl = await getOrgPortalBaseUrl(row.organization_id);
      const result = await sendOrgAlert(
        row.organization_id,
        "planChangeReminders",
        buildPlanChangeReminderEmail({
          orgName: row.org_name ?? "Your organization",
          currentPlanName: row.current_plan_name ?? "your current plan",
          pendingPlanName: row.pending_plan_name ?? row.pending_plan_id,
          effectiveAt,
          planPageUrl: `${baseUrl}/dashboard/revenue-rescue/plan`,
        }),
      );
      if (result.status === "sent") {
        await logAudit({
          organizationId: row.organization_id,
          actorLabel: "system",
          action: "subscription.downgrade_reminder_sent",
          targetType: "org_subscription",
          targetId: row.organization_id,
          metadata: { pendingPlanId: row.pending_plan_id, effectiveAt: effectiveAt.toISOString(), to: result.to },
        });
        outcomes.push({ organizationId: row.organization_id, status: "sent" });
      } else {
        // Preference-based skip: keep the claim so we don't re-check every pass.
        outcomes.push({ organizationId: row.organization_id, status: "skipped", reason: result.reason });
      }
    } catch (error) {
      // Delivery failure: release the claim so the next pass retries.
      console.error(`Plan change reminder failed for organization ${row.organization_id}`, error);
      await getPool()
        .query(
          "UPDATE org_subscriptions SET pending_plan_reminder_sent_at = NULL WHERE organization_id = $1 AND pending_plan_id IS NOT NULL",
          [row.organization_id],
        )
        .catch(() => {});
      outcomes.push({ organizationId: row.organization_id, status: "skipped", reason: "error" });
    }
  }
  return outcomes;
}

export type PendingPlanChange = { planId: string; planName: string; effectiveAt: string };

/**
 * Returns the org's scheduled plan change for display, lazily applying it
 * first if the effective date has already passed (so pages never show a
 * stale "switching on <past date>" banner, even if the cron pass is late).
 */
export async function getPendingPlanChange(organizationId: string): Promise<PendingPlanChange | null> {
  await applyDuePendingPlanChanges(new Date(), organizationId);
  const { rows } = await getPool().query(
    `SELECT s.pending_plan_id, s.pending_plan_effective_at, p.name
     FROM org_subscriptions s
     LEFT JOIN plan_definitions p ON p.id = s.pending_plan_id
     WHERE s.organization_id = $1 AND s.pending_plan_id IS NOT NULL`,
    [organizationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    planId: row.pending_plan_id,
    planName: row.name ?? row.pending_plan_id,
    effectiveAt: new Date(row.pending_plan_effective_at).toISOString(),
  };
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

/** Orgs whose scheduled plan change has failed at least one apply pass (admin console). */
export async function listFailingPlanChanges(): Promise<FailingPlanChange[]> {
  const { rows } = await getPool().query(
    `SELECT s.organization_id, o.name AS organization_name, s.plan_id, s.pending_plan_id,
            s.pending_plan_effective_at, s.pending_plan_failed_attempts, s.pending_plan_failure_alerted_at
     FROM org_subscriptions s
     JOIN organizations o ON o.id = s.organization_id
     WHERE s.pending_plan_id IS NOT NULL AND s.pending_plan_failed_attempts > 0
     ORDER BY s.pending_plan_failed_attempts DESC, s.pending_plan_effective_at ASC`,
  );
  return rows.map((row) => ({
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    planId: row.plan_id,
    pendingPlanId: row.pending_plan_id,
    effectiveAt: new Date(row.pending_plan_effective_at).toISOString(),
    failedAttempts: Number(row.pending_plan_failed_attempts),
    alertedAt: row.pending_plan_failure_alerted_at ? new Date(row.pending_plan_failure_alerted_at).toISOString() : null,
  }));
}

export type FailingPlanChange = {
  organizationId: string;
  organizationName: string;
  planId: string;
  pendingPlanId: string;
  effectiveAt: string;
  failedAttempts: number;
  alertedAt: string | null;
};
