import { NextResponse } from "next/server";
import { guard, readJson, requirePlatformAdmin, ApiError } from "@/lib/api-guard";
import { listOrganizations } from "@/lib/tenant";
import { provisionOrganization } from "@/lib/provisioning";
import { isFeatureKey, type FeatureKey } from "@/lib/entitlements";
import { isPlan } from "@/lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = guard(async () => {
  await requirePlatformAdmin();
  return NextResponse.json({ organizations: await listOrganizations() });
});

/** Provision a new client organization (platform admin only). */
export const POST = guard(async (request: Request) => {
  const admin = await requirePlatformAdmin();
  const body = await readJson(request);

  const name = String(body.name ?? "").trim();
  if (!name) throw new ApiError(400, "Company name is required.");
  const plan = String(body.plan ?? "starter");
  if (!isPlan(plan)) throw new ApiError(400, "Invalid plan.");
  const ownerEmail = String((body.owner as Record<string, unknown> | undefined)?.email ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new ApiError(400, "A valid owner email is required.");

  const modules: FeatureKey[] = Array.isArray(body.modules)
    ? body.modules.map(String).filter(isFeatureKey)
    : [];
  const allowedOrigins = Array.isArray(body.allowedOrigins)
    ? body.allowedOrigins.map(String).map((origin) => origin.trim()).filter(Boolean)
    : [];

  const result = await provisionOrganization(
    {
      name,
      slug: typeof body.slug === "string" ? body.slug : undefined,
      industry: typeof body.industry === "string" ? body.industry : null,
      timezone: typeof body.timezone === "string" && body.timezone ? body.timezone : undefined,
      plan,
      modules,
      usageLimits: typeof body.usageLimits === "object" && body.usageLimits ? (body.usageLimits as Record<string, number>) : {},
      brandPrimaryColor: typeof body.brandPrimaryColor === "string" ? body.brandPrimaryColor : null,
      brandSecondaryColor: typeof body.brandSecondaryColor === "string" ? body.brandSecondaryColor : null,
      logoUrl: typeof body.logoUrl === "string" ? body.logoUrl : null,
      allowedOrigins,
      owner: {
        email: ownerEmail,
        name: typeof (body.owner as Record<string, unknown>)?.name === "string" ? String((body.owner as Record<string, unknown>).name) : null,
      },
    },
    { userId: admin.user?.id ?? null, label: admin.actorLabel },
  );

  return NextResponse.json(
    { organizationId: result.organizationId, slug: result.slug, inviteToken: result.inviteToken },
    { status: 201 },
  );
});
