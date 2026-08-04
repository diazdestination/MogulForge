import { NextResponse } from "next/server";
import { ApiError, requireMember } from "@/lib/api-guard";
import { getOrganicWins } from "@/lib/discovery/closer-briefing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Organic wins: leads that reached appointment/estimate/won stage without ad spend. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    await requireMember(orgId);
    const wins = await getOrganicWins(orgId);
    return NextResponse.json(wins);
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Organic wins failed", error);
    return NextResponse.json({ error: "Could not load organic wins." }, { status: 500 });
  }
}
