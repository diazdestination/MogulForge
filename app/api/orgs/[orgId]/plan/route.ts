import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import {
  getPlanDefinition,
  getOrgSubscription,
  getCommercialState,
  setOrgSubscription,
  schedulePendingPlanChange,
  clearPendingPlanChange,
  nextUsagePeriodStart,
} from "@/lib/subscriptions";
import { getBillingAdapter } from "@/lib/billing";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * Self-serve plan change for org owners/admins. Upgrades (and trial
 * conversions) apply immediately; downgrades are scheduled for the start of
 * the next usage period so the paid-for tier keeps working until then.
 * Only public plans can be self-selected; changes are audit-logged.
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const body = await readJson(request);

  const planId = typeof body.planId === "string" ? body.planId.trim() : "";
  if (!planId) throw new ApiError(400, "planId is required.");

  const plan = await getPlanDefinition(planId);
  if (!plan || !plan.isPublic) throw new ApiError(400, "Unknown plan. Pick one of the available plans.");

  const state = await getCommercialState(org.id);
  if (!state) throw new ApiError(404, "Organization not found.");
  if (state.status === "suspended" || state.status === "cancelled") {
    throw new ApiError(403, "This account cannot change plans right now. Contact MogulForge support.", "account_blocked");
  }
  if (state.planId === planId) throw new ApiError(400, "The organization is already on this plan.");

  const previous = await getOrgSubscription(org.id);
  const currentPlan = await getPlanDefinition(state.planId);

  // A paid, active account moving to a cheaper plan is a downgrade: schedule
  // it for the next period start instead of applying it mid-period. Trial
  // conversions and upgrades always apply immediately.
  const isDowngrade =
    previous !== null && state.status !== "trialing" && currentPlan !== null && plan.price < currentPlan.price;

  if (isDowngrade) {
    const effectiveAt = nextUsagePeriodStart();
    await schedulePendingPlanChange(org.id, planId, effectiveAt);
    await logAudit({
      organizationId: org.id,
      actorUserId: user.id,
      actorLabel: user.email,
      action: "subscription.downgrade_scheduled",
      targetType: "org_subscription",
      targetId: org.id,
      metadata: { planId, currentPlanId: state.planId, effectiveAt: effectiveAt.toISOString() },
    });
    return NextResponse.json({
      ok: true,
      scheduled: true,
      planId,
      planName: plan.name,
      effectiveAt: effectiveAt.toISOString(),
      status: state.status,
    });
  }

  // Choosing a plan converts a trial to active; other states are preserved.
  const status = state.status === "trialing" ? "active" : state.status;

  const subscription = await setOrgSubscription(org.id, {
    planId,
    status,
    trialEndsAt: state.status === "trialing" ? null : (previous?.trialEndsAt ?? null),
    notes: previous?.notes ?? null,
  });
  // An immediate change supersedes any scheduled downgrade.
  if (previous?.pendingPlanId) await clearPendingPlanChange(org.id);

  const adapter = getBillingAdapter(subscription.billingProvider);
  const result = previous
    ? await adapter.changePlan({ organizationId: org.id, billingRef: subscription.billingRef, fromPlanId: state.planId, toPlanId: planId })
    : await adapter.createSubscription({ organizationId: org.id, planId });
  if (result.providerRef && result.providerRef !== subscription.billingRef) {
    await setOrgSubscription(org.id, { planId, status, trialEndsAt: subscription.trialEndsAt, notes: subscription.notes, billingRef: result.providerRef });
  }

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "subscription.self_service_change",
    targetType: "org_subscription",
    targetId: org.id,
    metadata: { planId, previousPlanId: state.planId, status, previousStatus: state.status, billingProvider: adapter.provider, billingNote: result.note },
  });

  return NextResponse.json({ ok: true, planId, planName: plan.name, status, note: result.note });
});

/** Cancels a scheduled (pending) downgrade — the org stays on its current plan. */
export const DELETE = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);

  const cleared = await clearPendingPlanChange(org.id);
  if (!cleared) throw new ApiError(404, "There is no scheduled plan change to cancel.");

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "subscription.downgrade_cancelled",
    targetType: "org_subscription",
    targetId: org.id,
    metadata: { keptPlanId: cleared.planId },
  });

  return NextResponse.json({ ok: true, planId: cleared.planId });
});
