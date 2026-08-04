import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { recordHeartbeat } from "@/lib/cron-heartbeat";
import { runWeeklyLeadDigest } from "@/lib/lead-digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "external" = bearer CRON_SECRET (the scheduler); "admin" = logged-in admin. */
async function authorized(request: Request): Promise<"external" | "admin" | false> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header === `Bearer ${secret}`) return "external";
  }
  return (await isAdmin()) ? "admin" : false;
}

async function run(force: boolean, auth: "external" | "admin") {
  try {
    const result = await runWeeklyLeadDigest({ force });
    // Only external scheduler hits count as heartbeats; a manual admin call
    // must not mask a dead scheduler. "skipped" (not due yet) still proves
    // the scheduler is alive, so any successful run records a heartbeat.
    if (auth === "external") await recordHeartbeat("lead-digest");
    return NextResponse.json(result);
  } catch (error) {
    console.error("Lead digest failed", error);
    return NextResponse.json({ error: "Lead digest failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authorized(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  return run(body?.force === true, auth);
}

/** GET support for simple external schedulers that can only ping a URL. Never forces. */
export async function GET(request: Request) {
  const auth = await authorized(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return run(false, auth);
}
