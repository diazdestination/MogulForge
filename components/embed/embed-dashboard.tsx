"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { accentBg, parseEmbedBranding, type EmbedBranding } from "./embed-branding";

type Metrics = {
  cards: Record<string, number>;
  funnel: Array<{ stage: string; count: number }>;
  campaignPerformance: Array<{ id: string; name: string; status: string; channel: string; messaged: number; replied: number }>;
} & Record<string, unknown>;

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-5";

function postHeight() {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ type: "rr:resize", height: document.documentElement.scrollHeight }, "*");
}

/** Reads the embed token from ?token=, loads metrics, and renders the dashboard module. */
export function EmbedDashboard() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [orgName, setOrgName] = useState("");
  const [branding, setBranding] = useState<EmbedBranding | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) {
      setError("Missing embed token. This module must be loaded through the Revenue Rescue embed loader.");
      return;
    }
    try {
      const res = await fetch("/api/embed/metrics", { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "This embed session is no longer valid.");
        return;
      }
      setMetrics(body.data);
      setOrgName(body.organization ?? "");
      setBranding(parseEmbedBranding(body));
      setError("");
    } catch {
      setError("Could not load dashboard data.");
    }
  }, [token]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);
  useEffect(() => {
    postHeight();
  });

  if (error) {
    return (
      <div className="p-6">
        <div className={`${box} border-red-400/30 text-sm text-red-200`}>{error}</div>
      </div>
    );
  }
  if (!metrics) return <div className="p-6 text-sm text-white/50">Loading dashboard…</div>;

  const cards: Array<{ label: string; key: string; money?: boolean }> = [
    { label: "Leads imported", key: "leadsImported" },
    { label: "High potential", key: "highPotential" },
    { label: "Active conversations", key: "activeConversations" },
    { label: "Appointments", key: "appointmentsBooked" },
    { label: "Recovered pipeline", key: "recoveredPipeline", money: true },
    { label: "Won revenue", key: "wonRevenue", money: true },
  ];

  return (
    <div className="space-y-5 p-5 text-white">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {branding?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- external client logo, unknown host
            <img src={branding.logoUrl} alt="" className="h-6 w-auto" />
          )}
          <h1 className="text-lg font-bold">{orgName ? `${orgName} — Revenue Rescue` : "Revenue Rescue"}</h1>
        </div>
        {(branding?.poweredBy.show ?? true) && (
          <span className="text-[10px] uppercase tracking-wider text-white/40">{branding?.poweredBy.label ?? "Powered by MogulForge"}</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {cards.map((card) => {
          const raw = metrics.cards?.[card.key];
          const value = typeof raw === "number" ? raw : 0;
          return (
            <div key={card.key} className={box}>
              <p className="text-xs text-white/50">{card.label}</p>
              <p className="mt-2 text-2xl font-bold">{card.money ? `$${Math.round(value).toLocaleString()}` : value.toLocaleString()}</p>
            </div>
          );
        })}
      </div>
      {Array.isArray(metrics.funnel) && metrics.funnel.length > 0 && (
        <div className={box}>
          <p className="text-xs font-bold uppercase tracking-wider text-white/50">Pipeline funnel</p>
          <div className="mt-3 space-y-2">
            {metrics.funnel.filter((f) => f.count > 0).map((step) => {
              const max = Math.max(...metrics.funnel.map((f) => f.count), 1);
              return (
                <div key={step.stage} className="flex items-center gap-3 text-xs">
                  <span className="w-36 shrink-0 capitalize text-white/60">{step.stage.replace(/_/g, " ")}</span>
                  <div className="h-2 flex-1 rounded-full bg-white/5">
                    <div className="h-2 rounded-full bg-forge-lime/70" style={{ width: `${Math.max(4, (step.count / max) * 100)}%`, ...accentBg(branding) }} />
                  </div>
                  <span className="w-10 text-right font-bold">{step.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
