import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { getUsageStatus } from "@/lib/usage";
import { SUBSCRIPTION_STATUS_LABELS } from "@/lib/usage-metrics";
import { listPublicPlans } from "@/lib/subscriptions";
import { MANAGER_ROLES } from "@/lib/roles";
import { PlanPicker, type PlanCard } from "@/components/plan-picker";

export const metadata: Metadata = { title: "Plan & Usage — Dashboard", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Plan, usage meters, and limit warnings for the active organization. */
export default async function PlanUsagePage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  const [usage, publicPlans] = await Promise.all([getUsageStatus(ctx.active.id), listPublicPlans()]);
  if (!usage) return null;

  const canManage = MANAGER_ROLES.includes(ctx.role);
  // For each candidate plan, the usage lines that would already be over its limits.
  const planCards: PlanCard[] = publicPlans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    blurb: plan.blurb,
    price: plan.price,
    cadence: plan.cadence,
    features: plan.features,
    featured: plan.featured,
    overLimit: usage.lines
      .filter((line) => {
        const limit = plan.limits[line.metric];
        return limit !== undefined && line.used > limit;
      })
      .map((line) => ({ label: line.label, used: line.used, limit: plan.limits[line.metric]! })),
  }));

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-5xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Plan & Usage</h1>

        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[.02] px-5 py-4">
          <span className="rounded-full border border-forge-lime/40 px-4 py-1.5 text-sm font-bold text-forge-lime">{usage.plan.name}</span>
          <span className="rounded-full border border-white/15 px-4 py-1.5 text-sm text-white/70">{SUBSCRIPTION_STATUS_LABELS[usage.status]}</span>
          <span className="text-sm text-white/50">Billing period {usage.period}</span>
          {usage.trialEndsAt && <span className="text-sm text-amber-300">Trial ends {new Date(usage.trialEndsAt).toLocaleDateString()}</span>}
          {usage.limitExempt && <span className="text-sm text-white/40">Internal account — limits do not apply.</span>}
        </div>

        {usage.gateBlock.blocked && (
          <div className="mt-4 rounded-xl border border-red-400/40 bg-red-400/5 px-5 py-4 text-sm text-red-300">
            {usage.gateBlock.reason} Opt-out processing, suppression updates, and data exports keep working.{" "}
            <a href="#plans" className="font-semibold text-red-200 underline underline-offset-2">See plans</a>
          </div>
        )}
        {!usage.gateBlock.blocked && usage.warnings.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-400/40 bg-amber-400/5 px-5 py-4 text-sm text-amber-200">
            {usage.warnings.some((w) => w.warning === 100)
              ? "One or more limits are fully used — actions that consume them are paused until the period resets or the plan is upgraded. Opt-outs and suppression updates always keep working."
              : "You are approaching one or more plan limits. Consider upgrading before actions get paused."}{" "}
            <a href="#plans" className="font-semibold text-amber-100 underline underline-offset-2">See plans</a>
          </div>
        )}

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {usage.lines.map((line) => {
            const pct = line.limit === null ? null : line.limit === 0 ? (line.used > 0 ? 100 : 0) : Math.min(100, Math.floor((line.used / line.limit) * 100));
            return (
              <div key={line.metric} className="rounded-xl border border-white/10 bg-white/[.02] p-5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold">{line.label}</p>
                  {line.warning !== null && (
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${line.warning >= 100 ? "border-red-400/50 text-red-400" : line.warning >= 90 ? "border-amber-400/50 text-amber-300" : "border-white/25 text-white/60"}`}>
                      {line.warning >= 100 ? "Limit reached" : `${line.warning}% used`}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-2xl font-semibold tabular-nums">
                  {line.used.toLocaleString()}
                  <span className="ml-1 text-sm font-normal text-white/40">/ {line.limit === null ? "unlimited" : line.limit.toLocaleString()}</span>
                </p>
                {pct !== null && (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div className={`h-full rounded-full ${pct >= 100 ? "bg-red-400" : pct >= 90 ? "bg-amber-400" : "bg-forge-lime"}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <PlanPicker orgId={ctx.active.id} currentPlanId={usage.plan.id} plans={planCards} canManage={canManage} />

        <p className="mt-8 text-xs text-white/40">
          Limits protect your plan, never your compliance: opt-out processing, do-not-contact list updates, and account-closure
          data exports are never blocked — even over limit or with a paused account. Questions about billing? Contact MogulForge support.
        </p>
      </div>
    </section>
  );
}
