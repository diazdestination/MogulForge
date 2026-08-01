import { ApiError, guard, requireUser } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { getMembership, getOrganizationById } from "@/lib/tenant";
import { getPool } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { escapeCsvCell } from "@/lib/rescue-import/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

/** Formula-safe CSV cell: shared escaping (incl. spreadsheet-formula neutralization). */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return escapeCsvCell(value instanceof Date ? value.toISOString() : value);
}

/**
 * ACCOUNT-CLOSURE EXPORT — the org's lead data as CSV.
 *
 * Deliberately NOT routed through requireMember or any usage gate: clients
 * must always be able to take their data with them, even when the org is
 * paused/cancelled, the subscription is suspended, or usage limits are
 * exhausted. Membership (owner/admin) is still verified — this loosens the
 * account-state checks, never the access control.
 */
export const GET = guard(async (_request: Request, { params }: Ctx) => {
  const { orgId } = await params;
  const user = await requireUser();
  const membership = await getMembership(orgId, user.id);
  if (!membership) throw new ApiError(403, "You do not have access to this organization.", "forbidden_org");
  if (!MANAGER_ROLES.includes(membership.role)) {
    throw new ApiError(403, "Only owners and admins can export organization data.", "forbidden_role");
  }
  const org = await getOrganizationById(orgId);
  if (!org) throw new ApiError(403, "You do not have access to this organization.", "forbidden_org");
  // NOTE: no org.status / subscription-state / usage-limit checks — by design.

  const { rows } = await getPool().query(
    `SELECT id, first_name, last_name, email, phone, address, city, state, zip, source,
            project_type, project_description, estimated_value, consent_status, pipeline_stage,
            score, category, suppressed, suppression_reason, notes, won_value, created_at, updated_at
     FROM rescue_leads WHERE organization_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );

  const header = [
    "id", "first_name", "last_name", "email", "phone", "address", "city", "state", "zip", "source",
    "project_type", "project_description", "estimated_value", "consent_status", "pipeline_stage",
    "score", "category", "suppressed", "suppression_reason", "notes", "won_value", "created_at", "updated_at",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((column) => csvCell(row[column])).join(","));
  }

  await logAudit({
    organizationId: orgId,
    actorUserId: user.id,
    actorLabel: user.email,
    action: "org_data.exported",
    targetType: "organization",
    targetId: orgId,
    metadata: { leadCount: rows.length },
  });

  return new Response(lines.join("\r\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${org.slug || "organization"}-leads-export.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
