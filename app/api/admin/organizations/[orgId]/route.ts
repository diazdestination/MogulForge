import { NextResponse } from "next/server";
import { guard, readJson, requirePlatformAdmin, ApiError } from "@/lib/api-guard";
import { getOrganizationById, listEntitlements, listInvites, listMembers, setEntitlement, updateOrganization } from "@/lib/tenant";
import { isFeatureKey } from "@/lib/entitlements";
import { isPlan, ORG_STATUSES, type OrgStatus } from "@/lib/plans";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

export const GET = guard(async (_request: Request, { params }: Ctx) => {
  await requirePlatformAdmin();
  const { orgId } = await params;
  const org = await getOrganizationById(orgId);
  if (!org) throw new ApiError(404, "Organization not found.");
  const [members, entitlements, invites] = await Promise.all([listMembers(orgId), listEntitlements(orgId), listInvites(orgId)]);
  return NextResponse.json({ organization: org, members, entitlements, invites });
});

/** Platform admin: update plan/status/limits/branding/origins and toggle modules. */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const admin = await requirePlatformAdmin();
  const { orgId } = await params;
  const org = await getOrganizationById(orgId);
  if (!org) throw new ApiError(404, "Organization not found.");
  const body = await readJson(request);

  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.industry === "string") patch.industry = body.industry.trim() || null;
  if (typeof body.timezone === "string" && body.timezone.trim()) patch.timezone = body.timezone.trim();
  if (typeof body.plan === "string") {
    if (!isPlan(body.plan)) throw new ApiError(400, "Invalid plan.");
    patch.plan = body.plan;
  }
  if (typeof body.status === "string") {
    if (!(ORG_STATUSES as readonly string[]).includes(body.status)) throw new ApiError(400, "Invalid status.");
    patch.status = body.status as OrgStatus;
  }
  if (typeof body.brandPrimaryColor === "string") patch.brandPrimaryColor = body.brandPrimaryColor.trim() || null;
  if (typeof body.brandSecondaryColor === "string") patch.brandSecondaryColor = body.brandSecondaryColor.trim() || null;
  if (typeof body.logoUrl === "string") patch.logoUrl = body.logoUrl.trim() || null;
  if (Array.isArray(body.allowedOrigins)) patch.allowedOrigins = body.allowedOrigins.map(String).map((o) => o.trim()).filter(Boolean);
  if (typeof body.usageLimits === "object" && body.usageLimits) patch.usageLimits = body.usageLimits;

  if (Object.keys(patch).length > 0) await updateOrganization(orgId, patch);

  if (typeof body.modules === "object" && body.modules && !Array.isArray(body.modules)) {
    for (const [key, enabled] of Object.entries(body.modules as Record<string, unknown>)) {
      if (isFeatureKey(key)) await setEntitlement(orgId, key, Boolean(enabled));
    }
  }

  await logAudit({
    organizationId: orgId,
    actorUserId: admin.user?.id ?? null,
    actorLabel: admin.actorLabel,
    action: "org.updated",
    targetType: "organization",
    targetId: orgId,
    metadata: { fields: Object.keys(patch), modules: typeof body.modules === "object" ? body.modules : undefined },
  });

  const updated = await getOrganizationById(orgId);
  return NextResponse.json({ organization: updated, entitlements: await listEntitlements(orgId) });
});
