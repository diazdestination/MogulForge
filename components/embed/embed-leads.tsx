"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { embedStyles, parseEmbedBranding, resolveEmbedTheme, type EmbedBranding } from "./embed-branding";

type EmbedLead = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  score: number | null;
  category: string | null;
  pipelineStage: string | null;
  createdAt: string;
};

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
  const [branding, setBranding] = useState<EmbedBranding | null>(null);
  const [error, setError] = useState("");

  const theme = useMemo(() => resolveEmbedTheme(branding, searchParams), [branding, searchParams]);
  const s = useMemo(() => embedStyles(theme, branding), [branding, theme]);

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
      setBranding(parseEmbedBranding(body));
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
      <div className="p-6" style={s.root}>
        <div className="p-5 text-sm" style={{ ...s.card, borderColor: "rgba(248,113,113,0.4)", ...s.error }}>{error}</div>
      </div>
    );
  }
  if (!leads) return <div className="p-6 text-sm" style={{ ...s.root, ...s.muted }}>Loading leads…</div>;

  const accent = String(s.accentSolid.backgroundColor);
  const rowBorder = theme.mode === "dark" ? "rgba(255,255,255,0.05)" : "rgba(17,20,24,0.07)";

  return (
    <div className="space-y-4 p-5" style={s.root}>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold">{branding?.displayName ? `${branding.displayName} — Recent leads` : "Recent leads"}</h1>
        {(branding?.poweredBy.show ?? true) && (
          <span className="text-[10px] uppercase tracking-wider" style={s.faint}>{branding?.poweredBy.label ?? "Powered by MogulForge"}</span>
        )}
      </div>
      {leads.length === 0 ? (
        <div className="p-5 text-sm" style={{ ...s.card, ...s.muted }}>No leads yet.</div>
      ) : (
        <div className="overflow-x-auto" style={s.card}>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider" style={{ borderBottom: `1px solid ${rowBorder}`, ...s.faint }}>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Score</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Stage</th>
                <th className="px-4 py-3 font-medium">Added</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead, i) => (
                <tr key={lead.id} style={i < leads.length - 1 ? { borderBottom: `1px solid ${rowBorder}` } : undefined}>
                  <td className="px-4 py-2.5 font-medium">
                    {[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {typeof lead.score === "number" ? (
                      <span className={lead.score >= 70 ? "font-bold" : undefined} style={lead.score >= 70 ? { color: accent } : s.muted}>{lead.score}</span>
                    ) : (
                      <span style={s.faint}>—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 capitalize" style={s.muted}>{lead.category ? lead.category.replace(/_/g, " ") : "—"}</td>
                  <td className="px-4 py-2.5 capitalize" style={s.muted}>{lead.pipelineStage ? lead.pipelineStage.replace(/_/g, " ") : "—"}</td>
                  <td className="px-4 py-2.5" style={s.muted}>{new Date(lead.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px]" style={s.faint}>
        Showing the {leads.length} most recent of {total.toLocaleString()} leads.
      </p>
    </div>
  );
}
