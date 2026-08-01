import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { listLeads } from "@/lib/rescue-analysis/store";
import { isLeadCategory, ANALYSIS_STATUSES } from "@/lib/rescue-analysis/categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * Lead list with score, category, and analysis status — the dashboard task
 * renders this. Filters: importId, category, analysisStatus, needsReview,
 * limit/offset. Sorted by score (highest first), then newest.
 */
export const GET = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org } = await requireMember(orgId);
  await requireEntitlement(org.id, "lead_import");

  const url = new URL(request.url);
  const category = url.searchParams.get("category") ?? undefined;
  if (category && !isLeadCategory(category)) throw new ApiError(400, "Unknown category filter.");
  const analysisStatus = url.searchParams.get("analysisStatus") ?? undefined;
  if (analysisStatus && !(ANALYSIS_STATUSES as readonly string[]).includes(analysisStatus)) {
    throw new ApiError(400, "Unknown analysisStatus filter.");
  }
  const needsReviewParam = url.searchParams.get("needsReview");
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);

  const { leads, total } = await listLeads(org.id, {
    importId: url.searchParams.get("importId") ?? undefined,
    category,
    analysisStatus,
    needsReview: needsReviewParam === null ? undefined : needsReviewParam === "true",
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? offset : 0,
  });
  return NextResponse.json({ leads, total });
});
