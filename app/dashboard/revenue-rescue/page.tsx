import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueOverviewPanel } from "@/components/rescue-overview-panel";

export const metadata: Metadata = { title: "Revenue Rescue — Dashboard", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Overview dashboard: recovered pipeline, funnel, hot opportunities, campaign performance, activity. */
export default async function RevenueRescueOverviewPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
            <h1 className="mt-4 font-display text-5xl font-semibold">Overview</h1>
          </div>
          {ctx.memberships.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {ctx.memberships.map((m) => (
                <Link key={m.id} href={`/dashboard/revenue-rescue?org=${m.id}`} className={`rounded-full border px-4 py-2 text-xs font-bold ${m.id === ctx.active.id ? "border-forge-lime text-forge-lime" : "border-white/15 text-white/50 hover:border-white/40"}`}>
                  {m.name}
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="mt-8">
          <RescueOverviewPanel orgId={ctx.active.id} />
        </div>
      </div>
    </section>
  );
}
