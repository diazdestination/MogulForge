import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { runOrgWeeklyDigests } from "@/lib/org-alerts";

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

/** Sends the per-org weekly activity digests (Settings → Notifications → weekly digest). */
export async function POST(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  try {
    const outcomes = await runOrgWeeklyDigests({ force: body?.force === true });
    return NextResponse.json({ outcomes });
  } catch (error) {
    console.error("Org weekly digests failed", error);
    return NextResponse.json({ error: "Org weekly digests failed" }, { status: 500 });
  }
}
