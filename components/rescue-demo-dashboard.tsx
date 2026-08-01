"use client";

import { useState } from "react";
import { demoActivity, demoCampaigns, demoFunnel, demoLeads, demoSummary, hotOpportunities, statusLabels, currency, type DemoLeadStatus } from "@/lib/rescue-demo-data";

const tabs = ["Overview", "Leads", "Campaigns", "Activity"] as const;
type Tab = (typeof tabs)[number];

const statusStyles: Record<DemoLeadStatus, string> = {
  analyzed: "border-white/20 text-white/60",
  queued: "border-white/20 text-white/60",
  contacted: "border-forge-lime/40 text-forge-lime",
  replied: "border-forge-lime/40 text-forge-lime",
  appointment: "border-forge-lime/60 bg-forge-lime/10 text-forge-lime",
  won: "border-forge-lime bg-forge-lime text-forge-ink",
  suppressed: "border-forge-rust/50 text-forge-rust",
  merged: "border-white/15 text-white/35",
  review: "border-forge-rust/50 text-forge-rust",
};

const filterOptions: { value: "all" | DemoLeadStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "queued", label: "Queued" },
  { value: "contacted", label: "Contacted" },
  { value: "replied", label: "Replied" },
  { value: "appointment", label: "Appointments" },
  { value: "won", label: "Sold" },
  { value: "review", label: "Needs review" },
  { value: "suppressed", label: "Suppressed" },
];

function ExampleBadge() {
  return <span className="rounded-full border border-forge-rust/40 bg-forge-rust/10 px-3 py-1 text-[10px] font-extrabold uppercase tracking-wider text-forge-rust">Example data</span>;
}

export function RescueDemoDashboard() {
  const [tab, setTab] = useState<Tab>("Overview");
  const [filter, setFilter] = useState<"all" | DemoLeadStatus>("all");

  const summaryCards = [
    { label: "Dormant leads imported", value: demoSummary.imported.toString() },
    { label: "Leads analyzed & scored", value: demoSummary.analyzed.toString() },
    { label: "High-potential opportunities", value: demoSummary.highPotential.toString() },
    { label: "Conversations restarted", value: demoSummary.conversations.toString() },
    { label: "Appointments booked", value: demoSummary.appointments.toString() },
    { label: "Active pipeline value", value: currency(demoSummary.pipelineValue) },
    { label: "Jobs sold", value: demoSummary.won.toString() },
    { label: "Recovered revenue", value: currency(demoSummary.recoveredRevenue) },
  ];

  const maxFunnel = demoFunnel[0].count;
  const visibleLeads = filter === "all" ? demoLeads : demoLeads.filter(l => l.status === filter);

  return <div className="rounded-[2rem] border border-white/15 bg-[#111815] p-3 sm:p-4">
    <div className="rounded-[1.5rem] border border-white/10 bg-forge-ink">
      {/* Chrome bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4 sm:px-7">
        <div className="flex items-center gap-3">
          <span className="grid h-8 w-8 place-items-center rounded-full border border-forge-lime text-[10px] font-extrabold text-forge-lime">MF</span>
          <div><p className="text-sm font-extrabold leading-tight">Sunline Exteriors (Demo Co.)</p><p className="text-[11px] text-white/40">Revenue Rescue · Simulation mode — no live messages are sent</p></div>
        </div>
        <ExampleBadge />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-white/10 px-3 sm:px-5" role="tablist" aria-label="Demo dashboard views">
        {tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`whitespace-nowrap px-4 py-3 text-xs font-extrabold uppercase tracking-wider transition ${tab === t ? "border-b-2 border-forge-lime text-forge-lime" : "text-white/45 hover:text-white"}`}>{t}</button>)}
      </div>

      <div className="p-5 sm:p-7">
        {tab === "Overview" && <div className="space-y-8">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map(c => <div key={c.label} className="rounded-2xl border border-white/10 bg-white/[.03] p-5">
              <p className="font-display text-3xl font-semibold text-forge-lime sm:text-4xl">{c.value}</p>
              <p className="mt-2 text-[11px] font-bold uppercase tracking-wider text-white/45">{c.label}</p>
            </div>)}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 p-5 sm:p-6">
              <div className="flex items-center justify-between"><h3 className="text-sm font-extrabold uppercase tracking-wider">Reactivation funnel</h3><ExampleBadge /></div>
              <div className="mt-6 space-y-4">
                {demoFunnel.map(f => <div key={f.stage}>
                  <div className="flex justify-between text-xs"><span className="font-bold text-white/60">{f.stage}</span><span className="font-extrabold text-forge-lime">{f.count}</span></div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-forge-moss to-forge-lime" style={{ width: `${Math.max(4, (f.count / maxFunnel) * 100)}%` }} /></div>
                </div>)}
              </div>
              <p className="mt-5 text-[11px] text-white/35">{demoSummary.suppressed} contacts suppressed (opt-out / do-not-contact) and excluded from all outreach.</p>
            </div>

            <div className="rounded-2xl border border-white/10 p-5 sm:p-6">
              <div className="flex items-center justify-between"><h3 className="text-sm font-extrabold uppercase tracking-wider">Hot opportunities</h3><ExampleBadge /></div>
              <div className="mt-4 divide-y divide-white/10">
                {hotOpportunities.map(l => <div key={l.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0"><p className="truncate text-sm font-extrabold">{l.name}</p><p className="truncate text-xs text-white/40">{l.trade} · {l.source} · {l.city}</p></div>
                  <div className="flex shrink-0 items-center gap-3"><span className="text-sm font-extrabold text-forge-lime">{currency(l.value)}</span><span className="grid h-9 w-9 place-items-center rounded-full border border-forge-lime/40 text-xs font-extrabold text-forge-lime">{l.score}</span></div>
                </div>)}
              </div>
            </div>
          </div>
        </div>}

        {tab === "Leads" && <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {filterOptions.map(o => <button key={o.value} onClick={() => setFilter(o.value)} className={`rounded-full border px-3.5 py-1.5 text-xs font-bold transition ${filter === o.value ? "border-forge-lime bg-forge-lime text-forge-ink" : "border-white/15 text-white/55 hover:border-forge-lime/50 hover:text-white"}`}>{o.label}</button>)}
            </div>
            <ExampleBadge />
          </div>
          <div className="mt-5 overflow-x-auto rounded-2xl border border-white/10">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead><tr className="border-b border-white/10 text-[11px] uppercase tracking-wider text-white/40">
                <th className="px-4 py-3 font-bold">Lead</th><th className="px-4 py-3 font-bold">Source</th><th className="px-4 py-3 font-bold">Dormant</th><th className="px-4 py-3 font-bold">Est. value</th><th className="px-4 py-3 font-bold">Score</th><th className="px-4 py-3 font-bold">Status</th><th className="px-4 py-3 font-bold">Next action</th>
              </tr></thead>
              <tbody className="divide-y divide-white/5">
                {visibleLeads.map(l => <tr key={l.id} className={l.status === "merged" || l.status === "suppressed" ? "opacity-50" : ""}>
                  <td className="px-4 py-3"><p className="font-extrabold">{l.name}</p><p className="text-xs text-white/40">{l.trade} · {l.city}</p></td>
                  <td className="px-4 py-3 text-white/55">{l.source}</td>
                  <td className="px-4 py-3 text-white/55">{l.age}</td>
                  <td className="px-4 py-3 font-bold text-white/75">{currency(l.value)}</td>
                  <td className="px-4 py-3">{l.score > 0 ? <span className="font-extrabold text-forge-lime">{l.score}</span> : <span className="text-white/30">—</span>}</td>
                  <td className="px-4 py-3"><span className={`inline-block rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ${statusStyles[l.status]}`}>{statusLabels[l.status]}</span></td>
                  <td className="max-w-[240px] px-4 py-3 text-xs text-white/50">{l.nextAction}<p className="mt-1 text-[11px] text-white/30">{l.note}</p></td>
                </tr>)}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-white/35">{visibleLeads.length} of {demoLeads.length} demo leads shown. All records are fictional.</p>
        </div>}

        {tab === "Campaigns" && <div>
          <div className="flex items-center justify-between"><h3 className="text-sm font-extrabold uppercase tracking-wider">Campaign performance</h3><ExampleBadge /></div>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {demoCampaigns.map(c => <div key={c.name} className="rounded-2xl border border-white/10 p-5 sm:p-6">
              <div className="flex items-start justify-between gap-3">
                <div><p className="font-extrabold">{c.name}</p><p className="mt-1 text-xs text-white/40">{c.channel} campaign</p></div>
                <span className={`rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide ${c.status === "Simulated" ? "border-forge-lime/40 text-forge-lime" : "border-white/20 text-white/45"}`}>{c.status}</span>
              </div>
              <div className="mt-5 grid grid-cols-4 gap-3 border-t border-white/10 pt-5 text-center">
                {[["Sent", c.sent.toString()], ["Replies", c.replies.toString()], ["Appts", c.appointments.toString()], ["Pipeline", c.pipeline ? currency(c.pipeline) : "—"]].map(([label, value]) => <div key={label}><p className="font-display text-2xl font-semibold text-forge-lime">{value}</p><p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-white/40">{label}</p></div>)}
              </div>
            </div>)}
          </div>
          <p className="mt-4 text-xs text-white/35">Simulation mode: campaign sends, replies, and bookings are simulated. No real messages were sent to anyone.</p>
        </div>}

        {tab === "Activity" && <div>
          <div className="flex items-center justify-between"><h3 className="text-sm font-extrabold uppercase tracking-wider">Recent activity</h3><ExampleBadge /></div>
          <div className="mt-5 divide-y divide-white/10 rounded-2xl border border-white/10 px-5">
            {demoActivity.map(a => <div key={a.text} className="flex items-start gap-4 py-4">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.kind === "suppression" || a.kind === "review" ? "bg-forge-rust" : a.kind === "won" || a.kind === "appointment" ? "bg-forge-lime" : "bg-white/30"}`} />
              <div><p className="text-sm text-white/75">{a.text}</p><p className="mt-1 text-[11px] text-white/35">{a.when} · simulated event</p></div>
            </div>)}
          </div>
        </div>}
      </div>
    </div>
  </div>;
}
