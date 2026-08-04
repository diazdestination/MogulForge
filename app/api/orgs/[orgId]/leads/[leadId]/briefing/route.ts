import { NextResponse } from "next/server";
import { ApiError, requireMember } from "@/lib/api-guard";
import { getCachedBriefing, generateCloserBriefing } from "@/lib/discovery/closer-briefing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET — returns the cached briefing (or null if not generated yet). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; leadId: string }> },
) {
  try {
    const { orgId, leadId } = await params;
    await requireMember(orgId);
    const briefing = await getCachedBriefing(orgId, leadId);
    return NextResponse.json({ briefing });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Get briefing failed", error);
    return NextResponse.json({ error: "Could not load briefing." }, { status: 500 });
  }
}

/** POST — generates (or regenerates) the briefing using AI, then caches it. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; leadId: string }> },
) {
  try {
    const { orgId, leadId } = await params;
    await requireMember(orgId);
    const briefing = await generateCloserBriefing(orgId, leadId);
    return NextResponse.json({ briefing });
  } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Generate briefing failed", error);
    return NextResponse.json({ error: "Could not generate briefing." }, { status: 500 });
  }
}
