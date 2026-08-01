import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueOverviewPanel } from "@/components/rescue-overview-panel";
import { getUsageStatus } from "@/lib/usage";

export const metadata: Metadata = { title: "Revenue Rescue — Dashboard", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Overview dashboard: recovered pipeline, funnel, hot opportunities, campaign performance, activity. */
export default async function RevenueRescueOverviewPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  const usage = await getUsageStatus(ctx.active.id).catch(() => null);
  const worstWarning = usage && !usage.limitExempt ? Math.max(0, ...usage.warnings.map((w) => w.warning ?? 0)) : 0;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        {usage?.gateBlock.blocked && (
          <div className="mb-6 rounded-xl border border-red-400/40 bg-red-400/5 px-5 py-4 text-sm text-red-300">
            {usage.gateBlock.reason} Opt-out processing, suppression updates, and data exports keep working.
          </div>
        )}
        {!usage?.gateBlock.blocked && worstWarning >= 75 && (
          <div className={`mb-6 rounded-xl border px-5 py-4 text-sm ${worstWarning >= 100 ? "border-red-400/40 bg-red-400/5 text-red-300" : "border-amber-400/40 bg-amber-400/5 text-amber-200"}`}>
            {worstWarning >= 100 ? "A plan limit has been reached — some actions are paused until the period resets or the plan changes." : `You have used ${worstWarning}% of at least one plan limit.`}{" "}
            <Link href={`/dashboard/revenue-rescue/plan?org=${ctx.active.id}`} className="font-bold underline">View plan & usage</Link>
          </div>
        )}
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
