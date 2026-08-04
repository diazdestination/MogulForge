import { NextResponse } from "next/server";
import { guard, readJson, requireMember, ApiError } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { updateOrganization } from "@/lib/tenant";
import { logAudit } from "@/lib/audit";
import { checkLogoUrl } from "@/lib/logo-url-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role } = await requireMember(orgId);
  return NextResponse.json({ organization: org, role });
});

export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const body = await readJson(request);
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.industry === "string") patch.industry = body.industry.trim() || null;
  if (typeof body.timezone === "string" && body.timezone.trim()) patch.timezone = body.timezone.trim();
  if (typeof body.brandPrimaryColor === "string") patch.brandPrimaryColor = body.brandPrimaryColor.trim() || null;
  if (typeof body.brandSecondaryColor === "string") patch.brandSecondaryColor = body.brandSecondaryColor.trim() || null;
  if (typeof body.logoUrl === "string") {
    const logoUrl = body.logoUrl.trim() || null;
    if (logoUrl !== null) {
      // Logo URLs are also fetched server-side (portal favicon), so every
      // write path enforces the same safe-URL policy.
      const verdict = checkLogoUrl(logoUrl);
      if (!verdict.ok) throw new ApiError(400, verdict.reason);
    }
    patch.logoUrl = logoUrl;
  }
  if (Object.keys(patch).length === 0) throw new ApiError(400, "No valid fields to update.");
  const updated = await updateOrganization(org.id, patch);
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "org.updated",
    targetType: "organization",
    targetId: org.id,
    metadata: { fields: Object.keys(patch) },
  });
  return NextResponse.json({ organization: updated });
});
