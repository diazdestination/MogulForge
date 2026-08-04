import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { recordHeartbeat } from "@/lib/cron-heartbeat";
import { processDueDeliveries } from "@/lib/webhooks/outgoing";

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

async function run(request: Request) {
  const auth = await authorized(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await processDueDeliveries();
    // Only external scheduler hits count as heartbeats; a manual admin call
    // must not mask a dead scheduler.
    if (auth === "external") await recordHeartbeat("webhook-deliveries");
    return NextResponse.json(result);
  } catch (error) {
    console.error("Webhook delivery processing failed", error);
    return NextResponse.json({ error: "Webhook delivery processing failed" }, { status: 500 });
  }
}

/** Retries due outgoing webhook deliveries (also runs on an in-app timer). */
export async function POST(request: Request) {
  return run(request);
}

/** GET support for simple external schedulers that can only ping a URL. */
export async function GET(request: Request) {
  return run(request);
}
