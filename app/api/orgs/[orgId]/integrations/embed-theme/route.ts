import { NextResponse } from "next/server";
import { guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { updateOrganization } from "@/lib/tenant";
import { MANAGER_ROLES } from "@/lib/roles";
import { normalizeEmbedTheme } from "@/lib/embed/theme-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Org-default theme for embedded modules (widget/dashboard on client sites). */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  return NextResponse.json({ theme: normalizeEmbedTheme(org.embedTheme) });
});

/**
 * Replaces the org-default embed theme (owners/admins). Values are normalized —
 * only hex colors, enum radii, and https logo URLs are stored, so nothing here
 * can inject arbitrary CSS into client sites.
 */
export const PATCH = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");
  const body = await readJson(request);
  const theme = normalizeEmbedTheme(body.theme ?? body);
  await updateOrganization(org.id, { embedTheme: theme });
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "org.embed_theme_updated",
    targetType: "organization",
    targetId: org.id,
    metadata: { theme },
  });
  return NextResponse.json({ theme });
});
