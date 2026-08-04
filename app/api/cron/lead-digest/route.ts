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

async function run(force: boolean) {
  try {
    const result = await runWeeklyLeadDigest({ force });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Lead digest failed", error);
    return NextResponse.json({ error: "Lead digest failed" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  return run(body?.force === true);
}

/** GET support for simple external schedulers that can only ping a URL. Never forces. */
export async function GET(request: Request) {
  if (!(await authorized(request))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return run(false);
}
