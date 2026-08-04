import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { recordHeartbeat } from "@/lib/cron-heartbeat";
import { listOrgsWithAnalyticsAccess, refreshAnalyticsSnapshots } from "@/lib/google-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled analytics ingestion: refreshes Search Console / GA4 snapshots for
 * every org that granted the read scopes. Triggered by the external scheduler
 * (CRON_SECRET bearer) — intended to run a few times a day; Google data lags
 * ~24h anyway, so hourly pulls buy nothing.
 */
async function authorized(request: Request): Promise<"external" | "admin" | false> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header === `Bearer ${secret}`) return "external";
  }
  return (await isAdmin()) ? "admin" : false;
}

async function run(request: Request) {
  const auth = await authorized(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const orgIds = await listOrgsWithAnalyticsAccess();
    let refreshed = 0;
    let failed = 0;
    // Sequential on purpose — polite to Google APIs and gentle on our own pool.
    for (const orgId of orgIds) {
      try {
        const result = await refreshAnalyticsSnapshots(orgId);
        refreshed += result.refreshed.length;
      } catch (error) {
        failed++;
        console.error(`Analytics refresh failed for org ${orgId}`, error);
      }
    }
    if (auth === "external") await recordHeartbeat("site-health");
    return NextResponse.json({ organizations: orgIds.length, snapshotsRefreshed: refreshed, organizationsFailed: failed });
  } catch (error) {
    console.error("Site-health analytics cron failed", error);
    return NextResponse.json({ error: "Analytics refresh failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return run(request);
}

/** GET support for simple external schedulers that can only ping a URL. */
export async function GET(request: Request) {
  return run(request);
}
