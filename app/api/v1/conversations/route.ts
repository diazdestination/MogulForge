import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, listResponse, parsePagination } from "@/lib/public-api/http";
import { listConversations } from "@/lib/rescue-engage/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/conversations — per-lead conversation threads. Scope: conversations:read. */
export const GET = guardV1(async (request: Request) => {
  const ctx = await requireApiKey(request, "conversations:read");
  const url = new URL(request.url);
  const pagination = parsePagination(url);
  const threads = await listConversations(ctx.org.id, { limit: 200 });
  const page = threads.slice(pagination.offset, pagination.offset + pagination.limit);
  return listResponse(page, pagination, threads.length, ctx.rateHeaders);
});
