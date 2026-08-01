"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { STAGE_LABELS } from "@/lib/rescue-engage/pipeline";
import { CATEGORY_LABELS, type LeadCategory } from "@/lib/rescue-analysis/categories";
import { buildRangePresets, rangeQuery, type ReportRange } from "@/lib/report-range";

type Breakdown = { leads: number; contacted: number; replied: number; pipelineValue: number; wonRevenue: number };

type Metrics = {
  range: ReportRange;
  summary: {
    leadsAdded: number; leadsContacted: number; leadsReplied: number;
    outboundMessages: number; simulatedSends: number; liveSends: number; delivered: number; inboundMessages: number;
    optOuts: number; appointmentsBooked: number; recoveredPipeline: number; wonRevenue: number; wonCount: number;
    replyRate: number | null; optOutRate: number | null;
  };
  funnel: Array<{ stage: string; count: number }>;
  campaigns: Array<{ id: string; name: string; channel: string; mode: string; status: string; enrolled: number; outbound: number; simulatedSends: number; delivered: number; replies: number; optOuts: number }>;
  sources: Array<Breakdown & { source: string }>;
  categories: Array<Breakdown & { category: string }>;
  trend: Array<{ bucket: string; outbound: number; inbound: number }>;
  trendGranularity: "day" | "week" | "month";
};

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const input = "rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white";
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

function BreakdownTable({ title, keyLabel, rows, empty }: {
  title: string; keyLabel: string; empty: string;
  rows: Array<Breakdown & { key: string; label: string }>;
}) {
  return (
    <div className={box}>
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-white/50">{empty}</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-white/40">
              <tr><th className="pb-2">{keyLabel}</th><th className="pb-2 text-right">Leads</th><th className="pb-2 text-right">Contacted</th><th className="pb-2 text-right">Replied</th><th className="pb-2 text-right">Pipeline</th><th className="pb-2 text-right">Won</th></tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="py-2 pr-2 font-semibold">{r.label}</td>
                  <td className="py-2 text-right">{r.leads}</td>
                  <td className="py-2 text-right">{r.contacted}</td>
                  <td className="py-2 text-right">{r.replied}</td>
                  <td className="py-2 text-right">{money(r.pipelineValue)}</td>
                  <td className="py-2 text-right">{money(r.wonRevenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function RescueReportsPanel({ orgId }: { orgId: string }) {
  const presets = useMemo(() => buildRangePresets(), []);
  const [presetKey, setPresetKey] = useState("30d");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [data, setData] = useState<{ metrics: Metrics; scopedToAssigned: boolean } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const range: ReportRange = useMemo(() => {
    if (presetKey === "custom") return { from: custom.from || null, to: custom.to || null };
    const preset = presets.find((p) => p.key === presetKey) ?? presets[1];
    return { from: preset.from, to: preset.to };
  }, [presetKey, custom, presets]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/reports${rangeQuery(range)}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not load the report."); return; }
      setData(body);
      setError("");
    } catch {
      setError("Could not load the report.");
    } finally {
      setLoading(false);
    }
  }, [orgId, range]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const m = data?.metrics;
  const maxFunnel = Math.max(1, ...(m?.funnel.map((f) => f.count) ?? [1]));
  const maxTrend = Math.max(1, ...(m?.trend.map((t) => t.outbound + t.inbound) ?? [1]));

  const cards = m ? [
    { label: "Leads added", value: m.summary.leadsAdded.toLocaleString() },
    { label: "Leads contacted", value: m.summary.leadsContacted.toLocaleString(), sub: `${m.summary.outboundMessages.toLocaleString()} outbound messages` },
    { label: "Reply rate", value: pct(m.summary.replyRate), sub: `${m.summary.leadsReplied} leads replied` },
    { label: "Opt-out rate", value: pct(m.summary.optOutRate), sub: `${m.summary.optOuts} opt-out${m.summary.optOuts === 1 ? "" : "s"}` },
    { label: "Recovered pipeline", value: money(m.summary.recoveredPipeline), sub: "value entering active stages" },
    { label: "Won revenue", value: money(m.summary.wonRevenue), sub: `${m.summary.wonCount} won` },
    { label: "Appointments booked", value: m.summary.appointmentsBooked.toLocaleString() },
    { label: "Messages", value: `${m.summary.simulatedSends.toLocaleString()} simulated`, sub: `${m.summary.delivered.toLocaleString()} delivered (live)` },
  ] : [];

  return (
    <div className="space-y-6">
      <div className={`${box} flex flex-wrap items-end gap-3`}>
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button key={p.key} type="button" onClick={() => setPresetKey(p.key)}
              className={`rounded-xl px-3.5 py-2 text-xs font-bold uppercase tracking-wide transition ${presetKey === p.key ? "bg-forge-lime text-black" : "bg-white/5 text-white/55 hover:bg-white/10 hover:text-white"}`}>
              {p.label}
            </button>
          ))}
          <button type="button" onClick={() => setPresetKey("custom")}
            className={`rounded-xl px-3.5 py-2 text-xs font-bold uppercase tracking-wide transition ${presetKey === "custom" ? "bg-forge-lime text-black" : "bg-white/5 text-white/55 hover:bg-white/10 hover:text-white"}`}>
            Custom
          </button>
        </div>
        {presetKey === "custom" && (
          <div className="flex items-end gap-2">
            <label className="block text-xs text-white/55">From
              <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className={`${input} mt-1 block`} />
            </label>
            <label className="block text-xs text-white/55">To
              <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className={`${input} mt-1 block`} />
            </label>
          </div>
        )}
        <div className="ml-auto">
          <a href={`/api/orgs/${orgId}/reports/export${rangeQuery(range)}`} className="btn-secondary px-4 py-2 text-xs">
            Export CSV
          </a>
        </div>
      </div>

      {error && <p className="rounded-2xl border border-forge-rust/40 bg-forge-rust/10 p-5 text-sm text-forge-rust">{error}</p>}
      {!error && !m && <p className="text-sm text-white/50">Loading report…</p>}
      {data?.scopedToAssigned && <p className="text-xs text-white/45">Showing your assigned leads only.</p>}

      {m && (
        <div className={loading ? "space-y-6 opacity-60 transition" : "space-y-6"}>
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
            <div className={box}>
              <h2 className="font-display text-xl font-semibold">Funnel — leads added in range</h2>
              <p className="mt-1 text-xs text-white/45">Current stage of every lead created in the selected range.</p>
              {m.summary.leadsAdded === 0 ? (
                <p className="mt-4 text-sm text-white/50">No leads were added in this range.</p>
              ) : (
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
              )}
            </div>

            <div className={box}>
              <h2 className="font-display text-xl font-semibold">Message activity</h2>
              <p className="mt-1 text-xs text-white/45">Outbound vs. inbound per {m.trendGranularity}.</p>
              {m.trend.length === 0 ? (
                <p className="mt-4 text-sm text-white/50">No messages in this range yet.</p>
              ) : (
                <>
                  <div className="mt-6 flex h-40 items-end gap-1.5">
                    {m.trend.map((t) => (
                      <div key={t.bucket} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${t.bucket}: ${t.outbound} outbound, ${t.inbound} inbound`}>
                        <div className="flex w-full flex-1 flex-col justify-end gap-0.5">
                          <div className="w-full rounded-t bg-forge-lime/80" style={{ height: `${(t.inbound / maxTrend) * 100}%` }} />
                          <div className="w-full rounded-t bg-white/25" style={{ height: `${(t.outbound / maxTrend) * 100}%` }} />
                        </div>
                        <span className="w-full truncate text-center text-[9px] text-white/40">{t.bucket.slice(5)}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-[10px] text-white/40">
                    <span className="mr-3"><span className="mr-1 inline-block h-2 w-2 rounded bg-forge-lime/80" />Inbound replies</span>
                    <span><span className="mr-1 inline-block h-2 w-2 rounded bg-white/25" />Outbound</span>
                  </p>
                </>
              )}
            </div>
          </div>

          <div className={box}>
            <h2 className="font-display text-xl font-semibold">Campaign comparison</h2>
            <p className="mt-1 text-xs text-white/45">Message counts are limited to the selected range; enrollment is the campaign total.</p>
            {m.campaigns.length === 0 ? (
              <p className="mt-4 text-sm text-white/50">No campaigns yet. Create one from the Campaigns tab.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[700px] text-left text-xs">
                  <thead className="text-[10px] uppercase tracking-wider text-white/40">
                    <tr><th className="pb-2">Campaign</th><th className="pb-2">Mode</th><th className="pb-2 text-right">Enrolled</th><th className="pb-2 text-right">Outbound</th><th className="pb-2 text-right">Simulated</th><th className="pb-2 text-right">Delivered</th><th className="pb-2 text-right">Replies</th><th className="pb-2 text-right">Opt-outs</th></tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {m.campaigns.map((c) => (
                      <tr key={c.id}>
                        <td className="py-2 pr-2">
                          <Link href={`/dashboard/revenue-rescue/campaigns/${c.id}?org=${orgId}`} className="font-semibold hover:text-forge-lime">{c.name}</Link>
                          <span className="ml-2 text-white/40">{c.channel.toUpperCase()} · {c.status}</span>
                        </td>
                        <td className="py-2 pr-2">
                          {c.mode === "simulation" ? <span className="rounded border border-yellow-400/50 px-1.5 py-0.5 text-[10px] font-bold text-yellow-300">SIM</span> : "Live"}
                        </td>
                        <td className="py-2 text-right">{c.enrolled}</td>
                        <td className="py-2 text-right">{c.outbound}</td>
                        <td className="py-2 text-right">{c.simulatedSends}</td>
                        <td className="py-2 text-right">{c.delivered}</td>
                        <td className="py-2 text-right">{c.replies}</td>
                        <td className="py-2 text-right">{c.optOuts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <BreakdownTable
              title="Lead sources"
              keyLabel="Source"
              empty="No leads in this range to break down by source."
              rows={m.sources.map((r) => ({ ...r, key: r.source, label: r.source }))}
            />
            <BreakdownTable
              title="Lead categories"
              keyLabel="Category"
              empty="No leads in this range to break down by category."
              rows={m.categories.map((r) => ({
                ...r,
                key: r.category,
                label: r.category === "uncategorized" ? "Not analyzed yet" : CATEGORY_LABELS[r.category as LeadCategory] ?? r.category,
              }))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
