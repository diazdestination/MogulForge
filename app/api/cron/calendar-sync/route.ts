import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { runCalendarSync } from "@/lib/calendar/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Inbound calendar sync pass: pulls external cancellations/reschedules for
 * synced Google/Outlook events and imports new Calendly bookings. Triggered by
 * an external scheduler (CRON_SECRET bearer) or a platform admin; also run by
 * the in-app interval while the process is warm.
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
    const result = await runCalendarSync();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Calendar sync failed", error);
    return NextResponse.json({ error: "Calendar sync failed" }, { status: 500 });
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
