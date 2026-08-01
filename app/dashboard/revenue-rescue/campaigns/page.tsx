import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueCampaignsPanel } from "@/components/rescue-campaigns-panel";

export const metadata: Metadata = { title: "Campaigns — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Campaign list + builder. All campaigns run in Simulation Mode until a provider is connected. */
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Campaigns</h1>
        <div className="mt-8">
          <RescueCampaignsPanel orgId={ctx.active.id} />
        </div>
      </div>
    </section>
  );
}
