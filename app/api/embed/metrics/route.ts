import { embedCorsHeaders, requireEmbedSession } from "@/lib/embed/auth";
import { getEmbedBranding } from "@/lib/branding";
import { guardV1 } from "@/lib/public-api/http";
import { getOverviewMetrics } from "@/lib/rescue-engage/metrics";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/embed/metrics — overview metrics for the embedded dashboard module. */
export const GET = guardV1(async (request: Request) => {
  const { org, claims } = await requireEmbedSession(request, "dashboard");
  const [metrics, branding] = await Promise.all([getOverviewMetrics(org.id, {}), getEmbedBranding(org)]);
  return NextResponse.json({ data: metrics, organization: branding.displayName, branding }, { headers: embedCorsHeaders(claims) });
});

export function OPTIONS(request: Request) {
  const origin = request.headers.get("origin") ?? "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      Vary: "Origin",
    },
  });
}
