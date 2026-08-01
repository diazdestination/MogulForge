import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1 } from "@/lib/public-api/http";
import { getOverviewMetrics } from "@/lib/rescue-engage/metrics";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/metrics — overview metrics (cards, funnel, campaign performance). Scope: metrics:read. */
export const GET = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "metrics:read");
  const metrics = await getOverviewMetrics(ctx.org.id, {});
  return NextResponse.json({ data: metrics }, { headers: ctx.rateHeaders });
});
