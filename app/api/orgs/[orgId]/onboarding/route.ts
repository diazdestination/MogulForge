import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import {
  completeOnboarding,
  getOnboardingRecord,
  getOnboardingStatus,
  isOnboardingStep,
  markOnboardingStep,
} from "@/lib/onboarding";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * Onboarding progress + live connection statuses. The statuses are recomputed
 * from actual state (OAuth rows, CRM connections, lead counts, origins) on
 * every request — step flags only record the user's wizard choices.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role } = await requireMember(orgId);
  await requireEntitlement(org.id, "revenue_rescue");
  const [record, status] = await Promise.all([getOnboardingRecord(org.id), getOnboardingStatus(org.id)]);
  return NextResponse.json({ record, status, canManage: (MANAGER_ROLES as readonly string[]).includes(role) });
});

/** Marks a step done/skipped, or the whole flow complete. Managers only. */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);

  if (body.completed === true) {
    const record = await completeOnboarding(org.id);
    await logAudit({
      organizationId: org.id,
      actorUserId: user.id,
      actorLabel: user.email,
      action: "onboarding.completed",
      targetType: "organization",
      targetId: org.id,
      metadata: { steps: record.steps },
    });
    return NextResponse.json({ record });
  }

  const step = typeof body.step === "string" ? body.step : "";
  const choice = body.status === "skipped" ? "skipped" : body.status === "done" ? "done" : null;
  if (!isOnboardingStep(step) || !choice) {
    throw new ApiError(400, "Provide { step: google|leads|website, status: done|skipped } or { completed: true }.");
  }
  const record = await markOnboardingStep(org.id, step, choice);
  return NextResponse.json({ record });
});
