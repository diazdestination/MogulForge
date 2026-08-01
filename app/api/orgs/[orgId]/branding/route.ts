import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { getEntitlement } from "@/lib/tenant";
import { BrandingValidationError, resolveOrgBranding, updateOrgBranding } from "@/lib/branding";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Effective branding + the stored settings (owners/admins manage them). */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId);
  const [branding, whiteLabel] = await Promise.all([resolveOrgBranding(org), getEntitlement(org.id, "white_label")]);
  return NextResponse.json({
    branding,
    whiteLabelEntitled: !!whiteLabel?.enabled,
    settings: {
      brandingLevel: org.brandingLevel,
      displayName: org.displayName,
      logoUrl: org.logoUrl,
      brandPrimaryColor: org.brandPrimaryColor,
      brandSecondaryColor: org.brandSecondaryColor,
      portalTitle: org.portalTitle,
      loginTitle: org.loginTitle,
      supportEmail: org.supportEmail,
      supportPhone: org.supportPhone,
      emailSenderName: org.emailSenderName,
      smsSenderName: org.smsSenderName,
      poweredByLabel: org.poweredByLabel,
    },
  });
});

/**
 * Updates branding settings. Never usage-gated; the white_label entitlement is
 * enforced at resolution time (an unentitled org can save white_label settings
 * but its portal renders as powered_by until MogulForge grants the entitlement).
 */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const body = await readJson(request);

  const fields = [
    "brandingLevel",
    "displayName",
    "logoUrl",
    "brandPrimaryColor",
    "brandSecondaryColor",
    "portalTitle",
    "loginTitle",
    "supportEmail",
    "supportPhone",
    "emailSenderName",
    "smsSenderName",
    "poweredByLabel",
  ] as const;
  const patch: Record<string, string | null> = {};
  for (const field of fields) {
    if (body[field] === undefined) continue;
    const value = body[field];
    if (value !== null && typeof value !== "string") throw new ApiError(400, `${field} must be a string or null.`);
    patch[field] = value as string | null;
  }
  if (Object.keys(patch).length === 0) throw new ApiError(400, "Provide at least one branding field to update.");

  let branding;
  try {
    branding = await updateOrgBranding(org.id, patch);
  } catch (error) {
    if (error instanceof BrandingValidationError) throw new ApiError(400, error.message);
    throw error;
  }

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "branding.updated",
    targetType: "organization",
    targetId: org.id,
    metadata: { fields: Object.keys(patch) },
  });
  return NextResponse.json({ branding });
});
