import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { SiteHealthPanel } from "@/components/site-health-panel";

export const metadata: Metadata = { title: "Site health — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Connection health in one place: whole-site access check, widget liveness,
 * Google / Search Console / GA4 analytics, plus CRM and calendar statuses.
 * Every status is recomputed live — this page never shows a hopeful assumption.
 */
export default async function SiteHealthPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Site health</h1>
        <p className="mt-3 max-w-2xl text-sm text-white/55">
          Proof that we&apos;re genuinely connected to your website — page access, widget liveness, and what&apos;s driving leads.
        </p>
        <div className="mt-8">
          <SiteHealthPanel orgId={ctx.active.id} />
        </div>
      </div>
    </section>
  );
}
