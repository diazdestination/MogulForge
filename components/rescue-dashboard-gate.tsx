import Link from "next/link";
import { FEATURE_LABELS } from "@/lib/entitlements";
import type { DashboardContext } from "@/lib/dashboard-context";

/** Fallback states for dashboard pages: no organization or missing entitlement. */
export function RescueDashboardGate({ ctx }: { ctx: Exclude<DashboardContext, { kind: "ok" } | { kind: "unauthenticated" }> }) {
  if (ctx.kind === "no_org") {
    return (
      <section className="shell py-20">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Revenue Rescue</p>
          <h1 className="mt-5 font-display text-5xl font-semibold">No workspace yet</h1>
          <p className="mt-4 text-sm leading-7 text-white/55">
            You&rsquo;re not part of an organization. Run the intake wizard to set up your Revenue Rescue workspace, or ask your team for an invite.
          </p>
          <Link href="/revenue-rescue/start" className="btn-primary mt-8 inline-flex">Start the intake wizard</Link>
        </div>
      </section>
    );
  }
  return (
    <section className="shell py-20">
      <div className="mx-auto max-w-2xl text-center">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-5 font-display text-5xl font-semibold">{FEATURE_LABELS[ctx.feature]} isn&rsquo;t enabled</h1>
        <p className="mt-4 text-sm leading-7 text-white/55">
          This module isn&rsquo;t part of this organization&rsquo;s plan yet. Contact us to enable it.
        </p>
        <Link href="/contact" className="btn-primary mt-8 inline-flex">Talk to us</Link>
      </div>
    </section>
  );
}
