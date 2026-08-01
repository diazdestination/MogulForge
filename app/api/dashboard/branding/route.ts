import { NextResponse } from "next/server";
import { guard, requireUser, ApiError } from "@/lib/api-guard";
import { getPool } from "@/lib/db";
import { getMembership } from "@/lib/tenant";
import { getEffectiveBranding } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Effective branding for the signed-in user's active org (?org= honored only
 * with a membership row). Used by the dashboard shell to theme the portal.
 */
export const GET = guard(async (request: Request) => {
  const user = await requireUser();
  const orgParam = new URL(request.url).searchParams.get("org");

  let orgId: string | null = null;
  if (orgParam) {
    const membership = await getMembership(orgParam, user.id);
    if (membership) orgId = orgParam;
  }
  if (!orgId) {
    const { rows } = await getPool().query(
      `SELECT o.id FROM memberships m JOIN organizations o ON o.id = m.organization_id
       WHERE m.user_id = $1 AND o.status = 'active' ORDER BY m.created_at ASC LIMIT 1`,
      [user.id],
    );
    orgId = rows[0]?.id ?? null;
  }
  if (!orgId) throw new ApiError(404, "No organization.", "no_org");

  const branding = await getEffectiveBranding(orgId);
  if (!branding) throw new ApiError(404, "No organization.", "no_org");
  return NextResponse.json({ branding });
});
