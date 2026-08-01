import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueTeamPanel } from "@/components/rescue-team-panel";
import { MANAGER_ROLES } from "@/lib/roles";

export const metadata: Metadata = { title: "Team — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Member + invite management. Role changes, removals, and invites are owner/admin only. */
export default async function TeamPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Team</h1>
        <div className="mt-8">
          <RescueTeamPanel
            orgId={ctx.active.id}
            canManage={MANAGER_ROLES.includes(ctx.role)}
            currentUserId={ctx.user.id}
          />
        </div>
      </div>
    </section>
  );
}
