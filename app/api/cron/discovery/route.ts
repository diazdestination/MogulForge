import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { recordHeartbeat } from "@/lib/cron-heartbeat";
import { listOrgsForDiscovery, runDiscoveryForOrg } from "@/lib/discovery/opportunity-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scheduled discovery run: finds revenue opportunities for every active
 * revenue_rescue org (stale estimates, hot uncontacted leads, crawl signals,
 * analytics query gaps, and Google Business Profile reviews when connected).
 *
 * Triggered by the external scheduler (CRON_SECRET bearer) — daily is
 * sufficient since most signals change on a day-to-day cadence.
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
    const orgIds = await listOrgsForDiscovery();
    let ran = 0;
    let failed = 0;
    let totalAdded = 0;

    // Sequential — gentle on external APIs and the DB pool
    for (const orgId of orgIds) {
      try {
        const result = await runDiscoveryForOrg(orgId);
        ran++;
        totalAdded += result.opportunitiesAdded;
      } catch (error) {
        failed++;
        console.error(`Discovery failed for org ${orgId}`, error);
      }
    }

    if (auth === "external") await recordHeartbeat("discovery");

    return NextResponse.json({
      organizations: orgIds.length,
      ran,
      failed,
      opportunitiesAdded: totalAdded,
    });
  } catch (error) {
    console.error("Discovery cron failed", error);
    return NextResponse.json({ error: "Discovery run failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return run(request);
}

export async function GET(request: Request) {
  return run(request);
}
