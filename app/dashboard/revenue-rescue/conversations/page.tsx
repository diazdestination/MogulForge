import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDashboardContext } from "@/lib/dashboard-context";
import { RescueDashboardGate } from "@/components/rescue-dashboard-gate";
import { RescueConversationsPanel } from "@/components/rescue-conversations-panel";
import { CONVERSATION_WRITE_ROLES } from "@/lib/roles";

export const metadata: Metadata = { title: "Conversations — Revenue Rescue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** Conversation inbox: message threads, reply classification, and follow-up tasks. */
export default async function ConversationsPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgParam } = await searchParams;
  const ctx = await getDashboardContext(orgParam, "revenue_rescue");
  if (ctx.kind === "unauthenticated") redirect("/login");
  if (ctx.kind !== "ok") return <RescueDashboardGate ctx={ctx} />;

  return (
    <section className="shell py-10">
      <div className="mx-auto max-w-6xl">
        <p className="eyebrow">Revenue Rescue · {ctx.active.name}</p>
        <h1 className="mt-4 font-display text-5xl font-semibold">Conversations</h1>
        <div className="mt-8">
          <RescueConversationsPanel orgId={ctx.active.id} canWrite={CONVERSATION_WRITE_ROLES.includes(ctx.role)} />
        </div>
      </div>
    </section>
  );
}
