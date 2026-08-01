import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { processDueDeliveries } from "@/lib/webhooks/outgoing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header === `Bearer ${secret}`) return true;
  }
  return isAdmin();
}

/** Retries due outgoing webhook deliveries (also runs on an in-app timer). */
export async function POST(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await processDueDeliveries();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Webhook delivery processing failed", error);
    return NextResponse.json({ error: "Webhook delivery processing failed" }, { status: 500 });
  }
}
