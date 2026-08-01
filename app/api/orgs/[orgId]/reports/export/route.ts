import { NextResponse } from "next/server";
import { guard, requireEntitlement, requireMember } from "@/lib/api-guard";
import { listReportRows, parseReportDate } from "@/lib/rescue-engage/reports";
import { ASSIGNED_ONLY_ROLES } from "@/lib/roles";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const HEADER = [
  "lead_id", "first_name", "last_name", "email", "phone", "source", "source_detail", "category", "score",
  "pipeline_stage", "estimated_value", "won_value", "consent_status", "suppressed",
  "outbound_messages", "inbound_messages", "appointments", "created_at", "stage_changed_at",
];

/** CSV of the underlying per-lead rows behind the report (same range + rep scoping). */
export const GET = guard(async (request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const { org, role, user } = await requireMember(orgId);
  await requireEntitlement(org.id, "analytics");
  const url = new URL(request.url);
  const range = { from: parseReportDate(url.searchParams.get("from")), to: parseReportDate(url.searchParams.get("to")) };
  const restricted = ASSIGNED_ONLY_ROLES.includes(role);
  const rows = await listReportRows(org.id, range, restricted ? { assignedUserId: user.id } : {});

  const lines = [HEADER.join(",")];
  for (const r of rows) {
    lines.push([
      r.id, r.firstName, r.lastName, r.email, r.phone, r.source, r.sourceDetail, r.category, r.score,
      r.pipelineStage, r.estimatedValue, r.wonValue, r.consentStatus, r.suppressed,
      r.outboundMessages, r.inboundMessages, r.appointments,
      new Date(r.createdAt).toISOString(), r.stageChangedAt ? new Date(r.stageChangedAt).toISOString() : "",
    ].map(csvField).join(","));
  }

  await logAudit({
    organizationId: org.id,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "report.exported",
    targetType: "report",
    targetId: "leads_csv",
    metadata: { from: range.from, to: range.to, rows: rows.length, scopedToAssigned: restricted },
  });

  const suffix = [range.from ?? "start", range.to ?? "today"].join("_to_");
  return new NextResponse(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="revenue-rescue-report_${suffix}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
