import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireEntitlement, requireMember } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { getOrgSettings } from "@/lib/org-settings";
import { hasRunningCrawl, startSiteCrawl } from "@/lib/site-crawler";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * POST /api/orgs/[orgId]/site-health/crawl — start (or re-run) the whole-site
 * access check. The crawl target is the org's own website on file (or an
 * explicit URL a manager submits); one crawl at a time per org.
 */
export const POST = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, user } = await requireMember(orgId, MANAGER_ROLES);
  await requireEntitlement(org.id, "revenue_rescue");

  if (await hasRunningCrawl(org.id)) throw new ApiError(409, "A site check is already running. Wait for it to finish.");

  const body = await readJson(request).catch(() => ({}) as Record<string, unknown>);
  const explicit = typeof body.url === "string" ? body.url.trim() : "";
  const settings = await getOrgSettings(org.id);
  const target = explicit || settings.contact.website || org.allowedOrigins.find((o) => !o.startsWith("*.")) || "";
  if (!target) {
    throw new ApiError(400, "No website on file. Add your website in Settings (or the guided setup) first.");
  }

  const pageCap = typeof body.pageCap === "number" ? body.pageCap : undefined;
  const result = await startSiteCrawl({ organizationId: org.id, rootUrl: target, createdBy: user.id, pageCap });
  // startSiteCrawl re-checks under a DB lock, so a concurrent start on another
  // server surfaces here as "already running" even after our fast-path check.
  if ("error" in result) throw new ApiError(result.error.includes("already running") ? 409 : 400, result.error);
  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "site_health.crawl.started",
    targetType: "organization",
    targetId: org.id,
    metadata: { rootUrl: target },
  });
  return NextResponse.json({ crawlId: result.crawlId }, { status: 202 });
});
