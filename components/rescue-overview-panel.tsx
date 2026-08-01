"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { STAGE_LABELS } from "@/lib/rescue-engage/pipeline";
import { CATEGORY_LABELS, type LeadCategory } from "@/lib/rescue-analysis/categories";

type Metrics = {
  cards: {
    leadsImported: number; leadsAnalyzed: number; highPotential: number; activeConversations: number;
    appointmentsBooked: number; estimatesIssued: number; recoveredPipeline: number; wonRevenue: number;
    contactedLeads: number; simulatedSends: number; liveSends: number; delivered: number;
    replyRate: number | null; optOutRate: number | null;
  };
  funnel: Array<{ stage: string; count: number }>;
  hotLeads: Array<{ id: string; firstName: string | null; lastName: string | null; score: number | null; category: string | null; estimatedValue: number | null; projectType: string | null; pipelineStage: string; recommendedAction: string | null; assignedName: string | null }>;
  campaignPerformance: Array<{ id: string; name: string; channel: string; mode: string; status: string; enrolled: number; simulatedSends: number; delivered: number; replies: number; optOuts: number }>;
  revenueOverTime: Array<{ month: string; pipeline: number; won: number }>;
  recentActivity: Array<{ id: string; activityType: string; title: string; detail: string | null; createdAt: string }>;
  openTasks: number;
};

type OverviewResponse = {
  metrics: Metrics;
  scopedToAssigned: boolean;
  providers: { sms: { connected: boolean }; email: { connected: boolean } };
};

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

export function RescueOverviewPanel({ orgId }: { orgId: string }) {
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/overview`, { cache: "no-store" });
      if (!res.ok) {
        setError((await res.json().catch(() => null))?.error ?? "Could not load the overview.");
        return;
      }
      setData(await res.json());
      setError("");
    } catch {
      setError("Could not load the overview.");
    }
  }, [orgId]);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  if (error) return <p className="rounded-2xl border border-forge-rust/40 bg-forge-rust/10 p-5 text-sm text-forge-rust">{error}</p>;
  if (!data) return <p className="text-sm text-white/50">Loading overview…</p>;
  const { metrics: m, scopedToAssigned, providers } = data;
  const simulationOnly = !providers.sms.connected && !providers.email.connected;
  const maxFunnel = Math.max(1, ...m.funnel.map((f) => f.count));
  const maxRevenue = Math.max(1, ...m.revenueOverTime.map((r) => r.pipeline + r.won));

  const cards: Array<{ label: string; value: string; sub?: string }> = [
    { label: "Leads imported", value: m.cards.leadsImported.toLocaleString(), sub: `${m.cards.leadsAnalyzed.toLocaleString()} analyzed` },
    { label: "High-potential opportunities", value: m.cards.highPotential.toLocaleString() },
    { label: "Conversations", value: m.cards.activeConversations.toLocaleString(), sub: `${m.openTasks} open task${m.openTasks === 1 ? "" : "s"}` },
    { label: "Appointments booked", value: m.cards.appointmentsBooked.toLocaleString(), sub: `${m.cards.estimatesIssued} estimates issued` },
    { label: "Recovered pipeline", value: money(m.cards.recoveredPipeline), sub: `${money(m.cards.wonRevenue)} won` },
    { label: "Messages", value: `${m.cards.simulatedSends.toLocaleString()} simulated`, sub: `${m.cards.delivered} delivered (live)` },
    { label: "Reply rate", value: pct(m.cards.replyRate), sub: `${m.cards.contactedLeads} leads contacted` },
    { label: "Opt-out rate", value: pct(m.cards.optOutRate) },
  ];

  return (
    <div className="space-y-8">
      {simulationOnly && (
        <div className="rounded-2xl border border-yellow-400/40 bg-yellow-400/10 px-5 py-4 text-sm text-yellow-200">
          <span className="font-bold uppercase tracking-wide">Simulation Mode</span> — no SMS or email provider is connected.
          Campaigns record simulated sends only; nothing is actually delivered to customers.
        </div>
      )}
      {scopedToAssigned && (
        <p className="text-xs text-white/45">Showing your assigned leads only.</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <div key={card.label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{card.label}</p>
            <p className="mt-2 font-display text-3xl font-semibold">{card.value}</p>
            {card.sub && <p className="mt-1 text-xs text-white/50">{card.sub}</p>}
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h2 className="font-display text-xl font-semibold">Opportunity funnel</h2>
          <div className="mt-4 space-y-2">
            {m.funnel.map((f) => (
              <div key={f.stage} className="flex items-center gap-3">
                <span className="w-36 shrink-0 text-xs text-white/55">{STAGE_LABELS[f.stage as keyof typeof STAGE_LABELS] ?? f.stage}</span>
                <div className="h-5 flex-1 overflow-hidden rounded bg-white/5">
                  <div className={`h-full rounded ${f.stage === "suppressed" || f.stage === "lost" ? "bg-white/20" : "bg-forge-lime/70"}`} style={{ width: `${(f.count / maxFunnel) * 100}%` }} />
                </div>
                <span className="w-10 text-right text-xs font-bold">{f.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h2 className="font-display text-xl font-semibold">Hot opportunities</h2>
          {m.hotLeads.length === 0 ? (
            <p className="mt-4 text-sm text-white/50">No high-potential leads yet. Import and analyze leads to surface them here.</p>
          ) : (
            <ul className="mt-4 divide-y divide-white/5">
              {m.hotLeads.map((lead) => (
                <li key={lead.id} className="py-2.5">
                  <Link href={`/dashboard/revenue-rescue/leads/${lead.id}?org=${orgId}`} className="group flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold group-hover:text-forge-lime">
                        {[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unnamed lead"}
                        {lead.projectType && <span className="ml-2 text-xs font-normal text-white/45">{lead.projectType}</span>}
                      </p>
                      <p className="truncate text-xs text-white/45">
                        {lead.category ? CATEGORY_LABELS[lead.category as LeadCategory] ?? lead.category : "—"}
                        {lead.recommendedAction ? ` · ${lead.recommendedAction}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-forge-lime">{lead.score ?? "—"}</p>
                      <p className="text-xs text-white/45">{lead.estimatedValue != null ? money(lead.estimatedValue) : ""}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h2 className="font-display text-xl font-semibold">Campaign performance</h2>
          {m.campaignPerformance.length === 0 ? (
            <p className="mt-4 text-sm text-white/50">No campaigns yet. Create one from the Campaigns tab.</p>
          ) : (
            <table className="mt-4 w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-white/40">
                <tr><th className="pb-2">Campaign</th><th className="pb-2">Mode</th><th className="pb-2 text-right">Enrolled</th><th className="pb-2 text-right">Simulated</th><th className="pb-2 text-right">Replies</th><th className="pb-2 text-right">Opt-outs</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {m.campaignPerformance.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2 pr-2">
                      <Link href={`/dashboard/revenue-rescue/campaigns/${c.id}?org=${orgId}`} className="font-semibold hover:text-forge-lime">{c.name}</Link>
                      <span className="ml-2 text-white/40">{c.channel.toUpperCase()} · {c.status}</span>
                    </td>
                    <td className="py-2 pr-2">
                      {c.mode === "simulation" ? <span className="rounded border border-yellow-400/50 px-1.5 py-0.5 text-[10px] font-bold text-yellow-300">SIM</span> : "Live"}
                    </td>
                    <td className="py-2 text-right">{c.enrolled}</td>
                    <td className="py-2 text-right">{c.simulatedSends}</td>
                    <td className="py-2 text-right">{c.replies}</td>
                    <td className="py-2 text-right">{c.optOuts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <h2 className="font-display text-xl font-semibold">Revenue over time</h2>
          {m.revenueOverTime.length === 0 ? (
            <p className="mt-4 text-sm text-white/50">Pipeline and won revenue will chart here as leads move through the funnel.</p>
          ) : (
            <div className="mt-6 flex h-40 items-end gap-3">
              {m.revenueOverTime.map((r) => (
                <div key={r.month} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex w-full flex-1 flex-col justify-end gap-0.5">
                    <div className="w-full rounded-t bg-forge-lime/80" style={{ height: `${(r.won / maxRevenue) * 100}%` }} title={`Won ${money(r.won)}`} />
                    <div className="w-full rounded-t bg-white/25" style={{ height: `${(r.pipeline / maxRevenue) * 100}%` }} title={`Pipeline ${money(r.pipeline)}`} />
                  </div>
                  <span className="text-[10px] text-white/45">{r.month.slice(2)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[10px] text-white/40"><span className="mr-3"><span className="mr-1 inline-block h-2 w-2 rounded bg-forge-lime/80" />Won</span><span><span className="mr-1 inline-block h-2 w-2 rounded bg-white/25" />Open pipeline</span></p>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
        <h2 className="font-display text-xl font-semibold">Recent activity</h2>
        {m.recentActivity.length === 0 ? (
          <p className="mt-4 text-sm text-white/50">Activity from imports, campaigns, replies, and appointments will appear here.</p>
        ) : (
          <ul className="mt-4 divide-y divide-white/5">
            {m.recentActivity.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm">{a.title}</p>
                  {a.detail && <p className="truncate text-xs text-white/45">{a.detail}</p>}
                </div>
                <span className="shrink-0 text-xs text-white/40">{new Date(a.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
