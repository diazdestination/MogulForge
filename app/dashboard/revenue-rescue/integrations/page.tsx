import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { getEntitlement } from "@/lib/tenant";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueIntegrationsPanel } from "@/components/rescue-integrations-panel";
import { MANAGER_ROLES } from "@/lib/roles";

export const metadata: Metadata = { title: "Integrations — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** API keys, webhooks, embeds, and CRM sync management for the org. */
export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  if (!MANAGER_ROLES.includes(ctx.role)) {
    return (
      <section className="shell py-10">
        <div className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
          <h1 className="font-display text-3xl font-semibold">Integrations</h1>
          <p className="mt-3 text-sm text-white/60">
            API keys, webhooks, and CRM connections can only be managed by organization owners and admins. Ask an admin if you need access.
          </p>
        </div>
      </section>
    );
  }

  const apiAccess = await getEntitlement(ctx.active.id, "api_access");

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Integrations</h1>
        <p className="mt-3 max-w-2xl text-sm text-white/60">
          Connect your website and tools to Revenue Rescue: scoped API keys, signed webhooks in both directions, secure embeds for client
          sites, and CRM field mapping.
        </p>
        <div className="mt-8">
          <RescueIntegrationsPanel orgId={ctx.active.id} apiAccessEnabled={apiAccess?.enabled === true} />
        </div>
      </div>
    </section>
  );
}
