import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { getPlanDefinition, getOrgSubscription, getCommercialState, setOrgSubscription } from "@/lib/subscriptions";
import { getBillingAdapter } from "@/lib/billing";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * Self-serve plan change (upgrade/downgrade) for org owners/admins.
 * Only public plans can be self-selected; the change goes through the
 * billing adapter and is audit-logged.
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
  // Choosing a plan converts a trial to active; other states are preserved.
  const status = state.status === "trialing" ? "active" : state.status;

  const subscription = await setOrgSubscription(org.id, {
    planId,
    status,
    trialEndsAt: state.status === "trialing" ? null : (previous?.trialEndsAt ?? null),
    notes: previous?.notes ?? null,
  });

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
