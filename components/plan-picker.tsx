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
export type PendingChange = { planId: string; planName: string; effectiveAt: string };

export function PlanPicker({
  orgId,
  currentPlanId,
  plans,
  canManage,
  pendingChange,
}: {
  orgId: string;
  currentPlanId: string;
  plans: PlanCard[];
  canManage: boolean;
  pendingChange?: PendingChange | null;
}) {
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
      setNotice(
        body?.scheduled
          ? `Downgrade scheduled — you'll switch to the ${body?.planName ?? planId} plan on ${new Date(body.effectiveAt).toLocaleDateString()}. Until then your current plan keeps working.`
          : `You're now on the ${body?.planName ?? planId} plan.`,
      );
      router.refresh();
    } catch {
      setError("Could not change the plan. Try again or contact support.");
    } finally {
      setBusy(false);
    }
  }

  async function cancelPendingChange() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/plan`, { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not cancel the scheduled change. Try again or contact support.");
        return;
      }
      setNotice("Scheduled plan change cancelled — you'll stay on your current plan.");
      router.refresh();
    } catch {
      setError("Could not cancel the scheduled change. Try again or contact support.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="plans" className="mt-10">
      <h2 className="font-display text-2xl font-semibold">Change plan</h2>
      <p className="mt-1 text-sm text-white/50">
        {canManage
          ? "Upgrades take effect immediately. Downgrades take effect at the start of your next billing period, so what you've paid for keeps working until then."
          : "Only organization owners and admins can change the plan. Ask an owner or admin to make the switch."}
      </p>

      {pendingChange && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-400/40 bg-sky-400/5 px-5 py-3 text-sm text-sky-200">
          <span>
            Switching to <span className="font-semibold">{pendingChange.planName}</span> on {new Date(pendingChange.effectiveAt).toLocaleDateString()}.
            Your current plan stays active until then.
          </span>
          {canManage && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void cancelPendingChange()}
              className="rounded-lg border border-sky-300/40 px-3 py-1.5 text-xs font-semibold text-sky-100 hover:border-sky-200/60 disabled:opacity-50"
            >
              {busy ? "Cancelling…" : "Cancel scheduled change"}
            </button>
          )}
        </div>
      )}

      {error && <div className="mt-4 rounded-xl border border-red-400/40 bg-red-400/5 px-5 py-3 text-sm text-red-300">{error}</div>}
      {notice && <div className="mt-4 rounded-xl border border-forge-lime/40 bg-forge-lime/5 px-5 py-3 text-sm text-forge-lime">{notice}</div>}

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = plan.id === currentPlanId;
          const isConfirming = confirming === plan.id;
          const hasOverLimit = plan.overLimit.length > 0;
          const currentPrice = plans.find((p) => p.id === currentPlanId)?.price;
          const isDowngrade = currentPrice !== undefined && plan.price < currentPrice;
          const isPendingTarget = pendingChange?.planId === plan.id;
          return (
            <div
              key={plan.id}
              className={`flex flex-col rounded-2xl border p-6 ${isCurrent ? "border-forge-lime/50 bg-forge-lime/[.04]" : "border-white/10 bg-white/[.02]"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-lg font-semibold">{plan.name}</p>
                {isCurrent && <span className="rounded-full border border-forge-lime/40 px-3 py-0.5 text-[11px] font-bold text-forge-lime">Current plan</span>}
                {!isCurrent && isPendingTarget && (
                  <span className="rounded-full border border-sky-400/40 px-3 py-0.5 text-[11px] font-bold text-sky-300">Scheduled</span>
                )}
                {!isCurrent && !isPendingTarget && plan.featured && <span className="rounded-full border border-white/20 px-3 py-0.5 text-[11px] text-white/60">Popular</span>}
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
                            {isDowngrade
                              ? "The switch takes effect at the start of your next billing period. If usage still exceeds these limits then, actions that consume them pause until usage drops. Opt-outs and suppression updates always keep working."
                              : "Switching now pauses actions that consume those limits until usage drops or the period resets. Opt-outs and suppression updates always keep working."}
                          </p>
                        </>
                      ) : isDowngrade ? (
                        <p className="text-sm text-white/70">
                          Switch to the {plan.name} plan? The change takes effect at the start of your next billing period — your current plan keeps working until then.
                        </p>
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
                          {busy ? "Switching…" : isDowngrade ? "Schedule switch" : hasOverLimit ? "Switch anyway" : "Confirm switch"}
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
