import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { recordHeartbeat } from "@/lib/cron-heartbeat";
import { applyDuePendingPlanChanges, sendDuePendingPlanChangeReminders } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Applies scheduled plan downgrades whose effective date has passed.
 * Idempotent — safe to trigger from external cron or by an admin.
 */
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
    const applied = await applyDuePendingPlanChanges();
    const reminders = await sendDuePendingPlanChangeReminders();
    // Only external scheduler hits count as heartbeats; a manual admin call
    // must not mask a dead scheduler.
    if (auth === "external") await recordHeartbeat("plan-changes");
    return NextResponse.json({
      applied: applied.length,
      changes: applied,
      remindersSent: reminders.filter((r) => r.status === "sent").length,
      reminders,
    });
  } catch (error) {
    console.error("Scheduled plan change pass failed", error);
    return NextResponse.json({ error: "Scheduled plan change pass failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return run(request);
}

/** GET support for simple external schedulers that can only ping a URL. */
export async function GET(request: Request) {
  return run(request);
}
