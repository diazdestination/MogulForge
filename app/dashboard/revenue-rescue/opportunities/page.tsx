import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { OpportunitiesPanel } from "@/components/opportunities-panel";

export const metadata: Metadata = {
  title: "Opportunities — Revenue Rescue",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Opportunities</h1>
        <p className="mt-3 max-w-2xl text-sm text-white/55">
          Revenue signals found across your leads, website, analytics, and Google reviews — before any ad spend.
          Every suggested action requires your approval; nothing sends itself.
        </p>
        <div className="mt-8">
          <OpportunitiesPanel orgId={ctx.active.id} />
        </div>
      </div>
    </section>
  );
}
