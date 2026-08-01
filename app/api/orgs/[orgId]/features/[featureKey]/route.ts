import { NextResponse } from "next/server";
import { guard, requireMember, requireEntitlement, ApiError } from "@/lib/api-guard";
import { isFeatureKey, FEATURE_LABELS } from "@/lib/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string; featureKey: string }> };

/**
 * Returns a feature module's configuration for the org. This is the canonical example of
 * entitlement enforcement: membership is required AND the module must be enabled — a
 * disabled module returns a clear 403 regardless of what the UI shows.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId, featureKey } = await params;
  const { org } = await requireMember(orgId);
  if (!isFeatureKey(featureKey)) throw new ApiError(404, "Unknown feature.");
  const entitlement = await requireEntitlement(org.id, featureKey);
  return NextResponse.json({
    feature: featureKey,
    label: FEATURE_LABELS[featureKey],
    enabled: true,
    limits: entitlement.limits,
    usageLimits: org.usageLimits,
  });
});
