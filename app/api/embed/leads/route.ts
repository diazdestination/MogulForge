import { embedCorsHeaders, requireEmbedSession } from "@/lib/embed/auth";
import { ApiError } from "@/lib/api-guard";
import { getEmbedBranding } from "@/lib/branding";
import { recordUsageInBackground, requireActionCapacity } from "@/lib/usage";
import { guardV1, PublicApiError, readV1Json } from "@/lib/public-api/http";
import { intakeLead, parseLeadIntake } from "@/lib/public-api/lead-intake";
import { listLeads } from "@/lib/rescue-analysis/store";
import { emitOrgEventInBackground } from "@/lib/webhooks/outgoing";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/embed/leads — recent leads for the embedded leads module (viewer-safe fields). */
export const GET = guardV1(async (request: Request) => {
  const { org, claims } = await requireEmbedSession(request, "leads");
  const [{ leads, total }, branding] = await Promise.all([
    listLeads(org.id, { limit: 25, sort: "created", dir: "desc" }),
    getEmbedBranding(org),
  ]);
  const data = leads.map((lead) => ({
    id: lead.id,
    firstName: lead.firstName,
    lastName: lead.lastName,
    score: lead.score,
    category: lead.category,
    pipelineStage: lead.pipelineStage,
    createdAt: lead.createdAt,
  }));
  return NextResponse.json({ data, total, branding }, { headers: embedCorsHeaders(claims) });
});

/** POST /api/embed/leads — lead capture from the embedded widget (module: lead_form). */
export const POST = guardV1(async (request: Request) => {
  const { org, claims } = await requireEmbedSession(request, "lead_form");
  // Usage gate + metering: widget lead capture counts against the same
  // import/stored-lead limits as every other lead-creation entry point.
  try {
    await requireActionCapacity(org.id, { leads_imported: 1, leads_stored: 1 });
  } catch (error) {
    if (error instanceof ApiError) throw new PublicApiError(403, error.code ?? "usage_limit_reached", error.message);
    throw error;
  }
  const body = await readV1Json(request);
  const parsed = parseLeadIntake(body);
  if (!parsed.input) throw new PublicApiError(422, "invalid_lead", parsed.message ?? "Invalid lead payload.");
  const result = await intakeLead(org.id, { ...parsed.input, source: "embed_widget", sourceDetail: claims.origin });
  if (result.outcome === "invalid") throw new PublicApiError(422, "invalid_lead", result.message);
  if (result.outcome === "duplicate") {
    // The visitor already exists as a lead — treat as accepted, no data leak.
    return NextResponse.json({ data: { accepted: true, duplicate: true } }, { status: 409, headers: embedCorsHeaders(claims) });
  }
  emitOrgEventInBackground(org.id, "lead.created", { lead_id: result.leadId, source: "embed_widget" });
  recordUsageInBackground(org.id, "leads_imported", 1);
  return NextResponse.json({ data: { accepted: true, id: result.leadId } }, { status: 201, headers: embedCorsHeaders(claims) });
});

export function OPTIONS(request: Request) {
  const origin = request.headers.get("origin") ?? "*";
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      Vary: "Origin",
    },
  });
}
