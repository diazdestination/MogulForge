import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, listResponse, parsePagination } from "@/lib/public-api/http";
import { listCampaigns } from "@/lib/rescue-engage/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/campaigns — list campaigns with stats. Scope: campaigns:read. */
export const GET = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "campaigns:read");
  const url = new URL(request.url);
  const pagination = parsePagination(url);
  const statusFilter = url.searchParams.get("status");
  let campaigns = await listCampaigns(ctx.org.id);
  if (statusFilter) campaigns = campaigns.filter((c) => c.status === statusFilter);
  const page = campaigns.slice(pagination.offset, pagination.offset + pagination.limit);
  return listResponse(page, pagination, campaigns.length, ctx.rateHeaders);
});
