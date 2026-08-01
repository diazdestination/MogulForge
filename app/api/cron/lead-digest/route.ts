import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin-auth";
import { runWeeklyLeadDigest } from "@/lib/lead-digest";

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

export async function POST(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  try {
    const result = await runWeeklyLeadDigest({ force: body?.force === true });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Lead digest failed", error);
    return NextResponse.json({ error: "Lead digest failed" }, { status: 500 });
  }
}
