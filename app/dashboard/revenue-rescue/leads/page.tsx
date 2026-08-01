import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueLeadsPanel } from "@/components/rescue-leads-panel";
import { CAMPAIGN_MANAGE_ROLES, LEAD_ACTION_ROLES } from "@/lib/roles";

export const metadata: Metadata = { title: "Leads — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Lead management: search, filters, sorting, pagination, and bulk actions. */
export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ org?: string; campaign?: string }> }) {
  const { org: orgParam, campaign } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "lead_import");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Leads</h1>
        <div className="mt-8">
          <RescueLeadsPanel
            orgId={ctx.active.id}
            canAct={LEAD_ACTION_ROLES.includes(ctx.role)}
            canManage={CAMPAIGN_MANAGE_ROLES.includes(ctx.role)}
            initialCampaignId={campaign ?? null}
          />
        </div>
      </div>
    </section>
  );
}
