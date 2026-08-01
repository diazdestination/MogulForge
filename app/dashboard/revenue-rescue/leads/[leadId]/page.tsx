import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueLeadDetailPanel } from "@/components/rescue-lead-detail-panel";
import { CAMPAIGN_MANAGE_ROLES, LEAD_ACTION_ROLES } from "@/lib/roles";

export const metadata: Metadata = { title: "Lead detail — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Lead detail: facts, score explanation, drafts, conversation, timeline, and lifecycle actions. */
export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ leadId: string }>;
  searchParams: Promise<{ org?: string }>;
}) {
  const { leadId } = await params;
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "lead_import");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-5xl">
        <RescueLeadDetailPanel
          orgId={ctx.active.id}
          leadId={leadId}
          canAct={LEAD_ACTION_ROLES.includes(ctx.role)}
          canManage={CAMPAIGN_MANAGE_ROLES.includes(ctx.role)}
        />
      </div>
    </section>
  );
}
