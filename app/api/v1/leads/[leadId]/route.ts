import { requireApiKey } from "@/lib/public-api/auth";
import { guardV1, PublicApiError } from "@/lib/public-api/http";
import { getLeadDetail } from "@/lib/rescue-analysis/store";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ leadId: string }> };

/** GET /api/v1/leads/:id — lead detail. Scope: leads:read. */
export const GET = guardV1(async (request: Request, { params }: Ctx) => {
  const ctx = await requireApiKey(request, "leads:read");
  const { leadId } = await params;
  const lead = await getLeadDetail(ctx.org.id, leadId).catch(() => null);
  if (!lead) throw new PublicApiError(404, "not_found", "Lead not found.");
  return NextResponse.json({ data: lead }, { headers: ctx.rateHeaders });
});
