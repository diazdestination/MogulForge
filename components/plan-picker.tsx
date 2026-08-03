"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export type PlanCard = {
  id: string;
  name: string;
  blurb: string;
  price: number;
  cadence: "per month" | "one-time";
  features: string[];
  featured: boolean;
  /** Usage lines that would be over this plan's limits if the org switched to it. */
  overLimit: { label: string; used: number; limit: number }[];
};

/**
 * Self-serve plan picker for the Plan & Usage page. Owner/admin members pick a
 * public plan; downgrades that would put the org over the new plan's limits
 * warn clearly before the change is confirmed.
 */
export function PlanPicker({ orgId, currentPlanId, plans, canManage }: { orgId: string; currentPlanId: string; plans: PlanCard[]; canManage: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function changePlan(planId: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not change the plan. Try again or contact support.");
        return;
      }
      setConfirming(null);
      setNotice(`You're now on the ${body?.planName ?? planId} plan.`);
      router.refresh();
    } catch {
      setError("Could not change the plan. Try again or contact support.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="plans" className="mt-10">
      <h2 className="font-display text-2xl font-semibold">Change plan</h2>
      <p className="mt-1 text-sm text-white/50">
        {canManage
          ? "Upgrades take effect immediately. Downgrades warn you first if current usage exceeds the new plan's limits."
          : "Only organization owners and admins can change the plan. Ask an owner or admin to make the switch."}
      </p>

      {error && <div className="mt-4 rounded-xl border border-red-400/40 bg-red-400/5 px-5 py-3 text-sm text-red-300">{error}</div>}
      {notice && <div className="mt-4 rounded-xl border border-forge-lime/40 bg-forge-lime/5 px-5 py-3 text-sm text-forge-lime">{notice}</div>}

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = plan.id === currentPlanId;
          const isConfirming = confirming === plan.id;
          const hasOverLimit = plan.overLimit.length > 0;
          return (
            <div
              key={plan.id}
              className={`flex flex-col rounded-2xl border p-6 ${isCurrent ? "border-forge-lime/50 bg-forge-lime/[.04]" : "border-white/10 bg-white/[.02]"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-lg font-semibold">{plan.name}</p>
                {isCurrent && <span className="rounded-full border border-forge-lime/40 px-3 py-0.5 text-[11px] font-bold text-forge-lime">Current plan</span>}
                {!isCurrent && plan.featured && <span className="rounded-full border border-white/20 px-3 py-0.5 text-[11px] text-white/60">Popular</span>}
              </div>
              <p className="mt-2 text-3xl font-semibold tabular-nums">
                ${plan.price.toLocaleString()}
                <span className="ml-1 text-sm font-normal text-white/40">{plan.cadence}</span>
              </p>
              {plan.blurb && <p className="mt-2 text-sm text-white/55">{plan.blurb}</p>}
              {plan.features.length > 0 && (
                <ul className="mt-4 space-y-1.5 text-sm text-white/70">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <span className="text-forge-lime">✓</span>
                      {feature}
                    </li>
                  ))}
                </ul>
              )}

              {canManage && !isCurrent && (
                <div className="mt-auto pt-5">
                  {isConfirming ? (
                    <div className="rounded-xl border border-white/15 bg-black/30 p-4">
                      {hasOverLimit ? (
                        <>
                          <p className="text-sm font-semibold text-amber-300">Heads up — your current usage exceeds this plan&apos;s limits:</p>
                          <ul className="mt-2 space-y-1 text-xs text-amber-200">
                            {plan.overLimit.map((line) => (
                              <li key={line.label}>
                                {line.label}: {line.used.toLocaleString()} used vs. a limit of {line.limit.toLocaleString()}
                              </li>
                            ))}
                          </ul>
                          <p className="mt-2 text-xs text-white/50">
                            Switching now pauses actions that consume those limits until usage drops or the period resets. Opt-outs and suppression updates always keep working.
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-white/70">Switch to the {plan.name} plan?</p>
                      )}
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void changePlan(plan.id)}
                          className={`rounded-lg px-4 py-2 text-sm font-bold text-black disabled:opacity-50 ${hasOverLimit ? "bg-amber-400" : "bg-forge-lime"}`}
                        >
                          {busy ? "Switching…" : hasOverLimit ? "Switch anyway" : "Confirm switch"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirming(null)}
                          className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirming(plan.id);
                        setError("");
                        setNotice("");
                      }}
                      className="w-full rounded-lg border border-white/20 px-4 py-2.5 text-sm font-semibold text-white transition hover:border-forge-lime/50 hover:text-forge-lime disabled:opacity-50"
                    >
                      Switch to {plan.name}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
