"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type EmbedLead = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  score: number | null;
  category: string | null;
  pipelineStage: string | null;
  createdAt: string;
};

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-5";

function postHeight() {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ type: "rr:resize", height: document.documentElement.scrollHeight }, "*");
}

/** Reads the embed token from ?token=, loads recent leads, and renders the leads module. */
export function EmbedLeads() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [leads, setLeads] = useState<EmbedLead[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) {
      setError("Missing embed token. This module must be loaded through the Revenue Rescue embed loader.");
      return;
    }
    try {
      const res = await fetch("/api/embed/leads", { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "This embed session is no longer valid.");
        return;
      }
      setLeads(body.data ?? []);
      setTotal(typeof body.total === "number" ? body.total : (body.data ?? []).length);
      setError("");
    } catch {
      setError("Could not load leads.");
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
  if (!leads) return <div className="p-6 text-sm text-white/50">Loading leads…</div>;

  return (
    <div className="space-y-4 p-5 text-white">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold">Recent leads</h1>
        <span className="text-[10px] uppercase tracking-wider text-white/40">Powered by MogulForge</span>
      </div>
      {leads.length === 0 ? (
        <div className={`${box} text-sm text-white/50`}>No leads yet.</div>
      ) : (
        <div className={`${box} overflow-x-auto p-0`}>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-[11px] uppercase tracking-wider text-white/40">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Score</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Stage</th>
                <th className="px-4 py-3 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-2.5 font-medium">
                    {[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {typeof lead.score === "number" ? (
                      <span className={lead.score >= 70 ? "font-bold text-forge-lime" : "text-white/80"}>{lead.score}</span>
                    ) : (
                      <span className="text-white/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 capitalize text-white/70">{lead.category ? lead.category.replace(/_/g, " ") : "—"}</td>
                  <td className="px-4 py-2.5 capitalize text-white/70">{lead.pipelineStage ? lead.pipelineStage.replace(/_/g, " ") : "—"}</td>
                  <td className="px-4 py-2.5 text-white/50">{new Date(lead.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-white/40">
        Showing the {leads.length} most recent of {total.toLocaleString()} leads.
      </p>
    </div>
  );
}
