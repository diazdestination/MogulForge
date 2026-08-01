import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueReportsPanel } from "@/components/rescue-reports-panel";

export const metadata: Metadata = { title: "Reports — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Tenant-scoped performance reporting over a selectable date range, with CSV export. */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "analytics");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Reports</h1>
        <div className="mt-8">
          <RescueReportsPanel orgId={ctx.active.id} />
        </div>
      </div>
    </section>
  );
}
