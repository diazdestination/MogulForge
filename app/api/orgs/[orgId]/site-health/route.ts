import { NextResponse } from "next/server";
import { guard, requireMember } from "@/lib/api-guard";
import { getOnboardingStatus } from "@/lib/onboarding";
import { getLatestSiteCrawl } from "@/lib/site-crawler";
import { countRecentLeads, listWidgetHeartbeats, widgetLiveness } from "@/lib/site-health";
import { getAnalyticsAccess, getAnalyticsSnapshots } from "@/lib/google-analytics";
import { getEntitlement } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * GET /api/orgs/[orgId]/site-health — everything the connection-health view
 * shows, in one call: whole-site access report, widget liveness per origin,
 * Google/Search Console/GA4 access + snapshots, and the shared live
 * connection statuses (CRM, calendar, website origins). All statuses are
 * recomputed live — nothing here is a stored "done" flag.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId);
  const [status, crawlResult, heartbeats, access, snapshots, leads28d, analyticsEntitlement] = await Promise.all([
    getOnboardingStatus(org.id),
    getLatestSiteCrawl(org.id),
    listWidgetHeartbeats(org.id),
    getAnalyticsAccess(org.id),
    getAnalyticsSnapshots(org.id),
    countRecentLeads(org.id, 28),
    getEntitlement(org.id, "analytics"),
  ]);

  const now = Date.now();
  const widgets = heartbeats.map((h) => ({ ...h, liveness: widgetLiveness(h.lastSeenAt, now) }));
  // Approved origins with no heartbeat ever = widget never installed there.
  const beatOrigins = new Set(heartbeats.map((h) => h.origin));
  const neverSeenOrigins = status.website.origins.filter((o) => !o.startsWith("*.") && !beatOrigins.has(normalizeOriginLoose(o)));

  return NextResponse.json({
    status,
    crawl: crawlResult ?? null,
    widgets,
    neverSeenOrigins,
    analytics: {
      access,
      analyticsEntitled: !!analyticsEntitlement?.enabled,
      snapshots,
      leads28d,
    },
  });
});

function normalizeOriginLoose(entry: string): string {
  try {
    return new URL(entry.includes("://") ? entry : `https://${entry}`).origin;
  } catch {
    return entry;
  }
}
