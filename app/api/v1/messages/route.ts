import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, listResponse, parsePagination, PublicApiError } from "@/lib/public-api/http";
import { listLeadMessages } from "@/lib/rescue-engage/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/messages?lead_id=… — message history for a lead. Scope: messages:read. */
export const GET = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "messages:read");
  const url = new URL(request.url);
  const pagination = parsePagination(url);
  const leadId = url.searchParams.get("lead_id");
  if (!leadId) throw new PublicApiError(400, "missing_parameter", "lead_id is required.");
  const messages = await listLeadMessages(ctx.org.id, leadId, 500).catch(() => []);
  const page = messages.slice(pagination.offset, pagination.offset + pagination.limit);
  return listResponse(page, pagination, messages.length, ctx.rateHeaders);
});
