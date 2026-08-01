import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueCampaignDetailPanel } from "@/components/rescue-campaign-detail-panel";

export const metadata: Metadata = { title: "Campaign — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Campaign detail: audience preview with exclusion accounting, activation, and enrolled leads. */
export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ org?: string }>;
}) {
  const { campaignId } = await params;
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-5xl">
        <RescueCampaignDetailPanel orgId={ctx.active.id} campaignId={campaignId} />
      </div>
    </section>
  );
}
