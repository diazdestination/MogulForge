import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { updateOrganization } from "@/lib/tenant";
import { getOrgSettings, updateOrgSettings } from "@/lib/org-settings";
import { touchedSections } from "@/lib/org-settings-schema";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Organization profile + settings. Any member can read; only owner/admin can write. */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role } = await requireMember(orgId);
  const settings = await getOrgSettings(org.id);
  return NextResponse.json({
    organization: { id: org.id, name: org.name, slug: org.slug, industry: org.industry, timezone: org.timezone },
    settings,
    role,
    canManage: MANAGER_ROLES.includes(role),
  });
});

export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { user, org } = await requireMember(orgId, MANAGER_ROLES);
  const body = await readJson(request);

  // Organization profile columns (name/industry/timezone live on the org row).
  const orgPatch: Record<string, unknown> = {};
  const profile = body.profile && typeof body.profile === "object" ? (body.profile as Record<string, unknown>) : {};
  if (typeof profile.name === "string") {
    const name = profile.name.trim();
    if (!name) throw new ApiError(400, "Organization name cannot be empty.");
    orgPatch.name = name.slice(0, 120);
  }
  if (typeof profile.industry === "string") orgPatch.industry = profile.industry.trim().slice(0, 120) || null;
  if (typeof profile.timezone === "string" && profile.timezone.trim()) {
    const timezone = profile.timezone.trim();
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new ApiError(400, "Unknown timezone. Use an IANA name like America/Chicago.");
    }
    orgPatch.timezone = timezone;
  }

  const sections = touchedSections(body);
  if (Object.keys(orgPatch).length === 0 && sections.length === 0) {
    throw new ApiError(400, "No valid fields to update.");
  }

  const organization = Object.keys(orgPatch).length > 0 ? await updateOrganization(org.id, orgPatch) : org;
  const settings = sections.length > 0 ? await updateOrgSettings(org.id, body) : await getOrgSettings(org.id);

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "org.settings_updated",
    targetType: "organization",
    targetId: org.id,
    metadata: { profileFields: Object.keys(orgPatch), sections },
  });

  return NextResponse.json({
    organization: organization
      ? { id: organization.id, name: organization.name, slug: organization.slug, industry: organization.industry, timezone: organization.timezone }
      : null,
    settings,
  });
});
