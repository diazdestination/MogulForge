import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, listResponse, parsePagination, PublicApiError, readV1Json } from "@/lib/public-api/http";
import { withIdempotency } from "@/lib/public-api/idempotency";
import { intakeLead, parseLeadIntake } from "@/lib/public-api/lead-intake";
import { listLeads, LEAD_SORT_KEYS, type LeadSortKey } from "@/lib/rescue-analysis/store";
import { isPipelineStage } from "@/lib/rescue-engage/pipeline";
import { emitOrgEventInBackground } from "@/lib/webhooks/outgoing";
import { pushLeadToCrmInBackground } from "@/lib/crm/sync";
import { ApiError } from "@/lib/api-guard";
import { recordUsageInBackground, requireActionCapacity } from "@/lib/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/leads — list leads with filtering + pagination. Scope: leads:read. */
export const GET = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "leads:read");
  const url = new URL(request.url);
  const pagination = parsePagination(url);

  const stage = url.searchParams.get("stage") ?? undefined;
  if (stage && !isPipelineStage(stage)) throw new PublicApiError(400, "invalid_parameter", `Unknown pipeline stage: ${stage}.`);
  const sortParam = url.searchParams.get("sort") ?? undefined;
  if (sortParam && !(LEAD_SORT_KEYS as readonly string[]).includes(sortParam)) {
    throw new PublicApiError(400, "invalid_parameter", `sort must be one of: ${LEAD_SORT_KEYS.join(", ")}.`);
  }
  const suppressedParam = url.searchParams.get("suppressed");
  const minScoreParam = url.searchParams.get("min_score");
  if (minScoreParam && (!Number.isInteger(Number(minScoreParam)) || Number(minScoreParam) < 0 || Number(minScoreParam) > 100)) {
    throw new PublicApiError(400, "invalid_parameter", "min_score must be an integer between 0 and 100.");
  }

  const { leads, total } = await listLeads(ctx.org.id, {
    search: url.searchParams.get("search") ?? undefined,
    stage,
    category: url.searchParams.get("category") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    importId: url.searchParams.get("import_id") ?? undefined,
    campaignId: url.searchParams.get("campaign_id") ?? undefined,
    minScore: minScoreParam ? Number(minScoreParam) : undefined,
    createdFrom: url.searchParams.get("created_from") ?? undefined,
    createdTo: url.searchParams.get("created_to") ?? undefined,
    suppressed: suppressedParam === null ? undefined : suppressedParam === "true",
    sort: (sortParam as LeadSortKey) ?? undefined,
    dir: url.searchParams.get("dir") === "asc" ? "asc" : "desc",
    limit: pagination.limit,
    offset: pagination.offset,
  });
  return listResponse(leads, pagination, total, ctx.rateHeaders);
});

/** POST /api/v1/leads — create a lead. Scope: leads:write. Supports Idempotency-Key. */
export const POST = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "leads:write");
  const body = await readV1Json(request);
  return withIdempotency(ctx.org.id, "POST /v1/leads", request, body, async () => {
    // Usage gate: lead creation counts against import/stored-lead limits.
    try {
      await requireActionCapacity(ctx.org.id, { leads_imported: 1, leads_stored: 1 });
    } catch (error) {
      if (error instanceof ApiError) throw new PublicApiError(403, error.code ?? "usage_limit_reached", error.message);
      throw error;
    }
    const parsed = parseLeadIntake(body);
    if (!parsed.input) throw new PublicApiError(422, "invalid_lead", parsed.message ?? "Invalid lead payload.");
    const result = await intakeLead(ctx.org.id, parsed.input);
    if (result.outcome === "invalid") throw new PublicApiError(422, "invalid_lead", result.message);
    if (result.outcome === "duplicate") {
      throw new PublicApiError(409, "duplicate_lead", "A lead with the same email, phone, or external record id already exists.", {
        existing_lead_id: result.leadId,
      });
    }
    emitOrgEventInBackground(ctx.org.id, "lead.created", { lead_id: result.leadId, source: "public_api" });
    // Suppressed (do-not-contact) leads are deliberately withheld from external CRMs.
    if (!result.suppressed) pushLeadToCrmInBackground(ctx.org.id, result.leadId);
    recordUsageInBackground(ctx.org.id, "leads_imported", 1);
    return { status: 201, body: { data: { id: result.leadId, suppressed: result.suppressed } }, headers: ctx.rateHeaders };
  });
});
