import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { applyDuePendingPlanChanges, sendDuePendingPlanChangeReminders } from "@/lib/subscriptions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Applies scheduled plan downgrades whose effective date has passed.
 * Idempotent — safe to trigger from external cron or by an admin.
 */
async function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header === `Bearer ${secret}`) return true;
  }
  return isAdmin();
}

async function run() {
  try {
    const applied = await applyDuePendingPlanChanges();
    const reminders = await sendDuePendingPlanChangeReminders();
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
  if (!(await authorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return run();
}

/** GET support for simple external schedulers that can only ping a URL. */
export async function GET(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return run();
}
