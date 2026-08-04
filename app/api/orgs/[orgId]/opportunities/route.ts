import { NextResponse } from "next/server";
import { ApiError, requireMember } from "@/lib/api-guard";
import { listOpportunities } from "@/lib/discovery/opportunity-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    await requireMember(orgId);
    const url = new URL(request.url);
    const includeActioned = url.searchParams.get("includeActioned") === "true";
    const includeDismissed = url.searchParams.get("includeDismissed") === "true";
    const opportunities = await listOpportunities(orgId, { includeActioned, includeDismissed });
    return NextResponse.json({ opportunities });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("List opportunities failed", error);
    return NextResponse.json({ error: "Could not load opportunities." }, { status: 500 });
  }
}
