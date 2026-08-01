import { NextResponse } from "next/server";
import { ApiError, guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { getLeadFilterOptions, listLeads, LEAD_SORT_KEYS, type LeadSortKey } from "@/lib/rescue-analysis/store";
import { isLeadCategory, ANALYSIS_STATUSES } from "@/lib/rescue-analysis/categories";
import { isPipelineStage } from "@/lib/rescue-engage/pipeline";
import { ASSIGNED_ONLY_ROLES } from "@/lib/roles";
import { listMembers } from "@/lib/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/**
 * Lead list with search, filters (score, category, source, project, date,
 * campaign, assignment, stage), sorting, and pagination. Sales reps are
 * restricted to their assigned leads server-side regardless of query params.
 */
export const GET = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "lead_import");

  const url = new URL(request.url);
  const q = (name: string) => url.searchParams.get(name) ?? undefined;

  const category = q("category");
  if (category && !isLeadCategory(category)) throw new ApiError(400, "Unknown category filter.");
  const analysisStatus = q("analysisStatus");
  if (analysisStatus && !(ANALYSIS_STATUSES as readonly string[]).includes(analysisStatus)) {
    throw new ApiError(400, "Unknown analysisStatus filter.");
  }
  const stage = q("stage");
  if (stage && !isPipelineStage(stage)) throw new ApiError(400, "Unknown stage filter.");
  const sortParam = q("sort");
  const sort: LeadSortKey | undefined =
    sortParam && (LEAD_SORT_KEYS as readonly string[]).includes(sortParam) ? (sortParam as LeadSortKey) : undefined;

  const needsReviewParam = url.searchParams.get("needsReview");
  const suppressedParam = url.searchParams.get("suppressed");
  const minScoreRaw = Number.parseInt(url.searchParams.get("minScore") ?? "", 10);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const restricted = ASSIGNED_ONLY_ROLES.includes(role);

  const [{ leads, total }, options, members] = await Promise.all([
    listLeads(org.id, {
      importId: q("importId"),
      category,
      analysisStatus,
      needsReview: needsReviewParam === null ? undefined : needsReviewParam === "true",
      search: q("search"),
      source: q("source"),
      projectType: q("projectType"),
      minScore: Number.isFinite(minScoreRaw) ? minScoreRaw : undefined,
      stage,
      campaignId: q("campaignId"),
      assignedTo: q("assignedTo"),
      createdFrom: q("createdFrom"),
      createdTo: q("createdTo"),
      suppressed: suppressedParam === null ? undefined : suppressedParam === "true",
      restrictToUserId: restricted ? user.id : undefined,
      sort,
      dir: url.searchParams.get("dir") === "asc" ? "asc" : "desc",
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    }),
    getLeadFilterOptions(org.id),
    listMembers(org.id),
  ]);
  return NextResponse.json({
    leads,
    total,
    options,
    members: members.map((m) => ({ userId: m.userId, name: m.name, role: m.role })),
    scopedToAssigned: restricted,
    role,
  });
});
