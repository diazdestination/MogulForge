"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

type OpportunityKind = "stale_estimate" | "hot_uncontacted" | "no_cta_page" | "query_spike" | "gbp_review";
type OpportunityStatus = "new" | "actioned" | "dismissed";

type Opportunity = {
  id: string;
  kind: OpportunityKind;
  title: string;
  evidence: Record<string, unknown>;
  actionHint: string;
  status: OpportunityStatus;
  leadId: string | null;
  createdAt: string;
};

const KIND_LABELS: Record<OpportunityKind, string> = {
  stale_estimate: "Open estimate",
  hot_uncontacted: "Hot lead",
  no_cta_page: "Missing CTA",
  query_spike: "Search gap",
  gbp_review: "Unanswered review",
};

const KIND_COLORS: Record<OpportunityKind, string> = {
  stale_estimate: "bg-amber-400/15 text-amber-300",
  hot_uncontacted: "bg-forge-rust/20 text-forge-rust",
  no_cta_page: "bg-blue-400/15 text-blue-300",
  query_spike: "bg-purple-400/15 text-purple-300",
  gbp_review: "bg-forge-lime/15 text-forge-lime",
};

const KIND_ICONS: Record<OpportunityKind, string> = {
  stale_estimate: "⏳",
  hot_uncontacted: "🔥",
  no_cta_page: "📄",
  query_spike: "📈",
  gbp_review: "⭐",
};

function evidenceSnippet(kind: OpportunityKind, evidence: Record<string, unknown>): string {
  switch (kind) {
    case "stale_estimate": {
      const val = typeof evidence.estimatedValue === "number" ? ` · $${Math.round(evidence.estimatedValue).toLocaleString()}` : "";
      return `Estimate sent ${String(evidence.estimateDate ?? "").slice(0, 10)}${val}`;
    }
    case "hot_uncontacted": {
      const score = evidence.score != null ? ` · Score ${String(evidence.score)}/10` : "";
      return `${String(evidence.category ?? "high-score")} category${score} · ${String(evidence.projectType ?? "project unspecified")}`;
    }
    case "no_cta_page":
      return String(evidence.url ?? "");
    case "query_spike":
      return `${Number(evidence.impressions ?? 0).toLocaleString()} impressions · avg position ${Number(evidence.position ?? 0).toFixed(1)}`;
    case "gbp_review": {
      const comment = typeof evidence.comment === "string" ? `"${evidence.comment.slice(0, 100)}…"` : "";
      return comment || String(evidence.reviewer ?? "");
    }
    default:
      return "";
  }
}

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";

export function OpportunitiesPanel({ orgId }: { orgId: string }) {
  const searchParams = useSearchParams();
  const orgSuffix = searchParams.get("org") ? `?org=${searchParams.get("org")}` : "";

  const [items, setItems] = useState<Opportunity[]>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = showDismissed ? "?includeDismissed=true&includeActioned=true" : "";
      const res = await fetch(`/api/orgs/${orgId}/opportunities${qs}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not load opportunities."); return; }
      setItems((body.opportunities as Opportunity[]) ?? []);
      setError("");
    } catch {
      setError("Could not load opportunities.");
    } finally {
      setLoading(false);
    }
  }, [orgId, showDismissed]);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function updateStatus(id: string, status: "actioned" | "dismissed") {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      const res = await fetch(`/api/orgs/${orgId}/opportunities/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setNotice(body?.error ?? "Could not update.");
      } else {
        setNotice(status === "dismissed" ? "Dismissed." : "Marked as actioned.");
        void Promise.resolve().then(load);
      }
    } catch {
      setNotice("Could not update.");
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  const visible = showDismissed ? items : items.filter((i) => i.status !== "dismissed");
  const openCount = items.filter((i) => i.status === "new").length;

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-white/55">
          {loading ? "Loading…" : `${openCount} open opportunit${openCount === 1 ? "y" : "ies"}`}
        </p>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-white/55">
            <input type="checkbox" className="accent-forge-lime" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
            Show dismissed
          </label>
        </div>
      </div>

      {notice && (
        <p className="rounded-xl bg-forge-lime/10 px-4 py-2 text-sm text-forge-lime">{notice}</p>
      )}
      {error && (
        <p className="rounded-2xl border border-forge-rust/40 bg-forge-rust/10 p-5 text-sm text-forge-rust">{error}</p>
      )}

      {!loading && visible.length === 0 && !error && (
        <div className={box}>
          <p className="text-sm text-white/50">
            {items.length === 0
              ? "No opportunities found yet. Run discovery from the Site health page or wait for the next scheduled scan."
              : "All opportunities have been dismissed. Toggle 'Show dismissed' to review them."}
          </p>
        </div>
      )}

      {visible.map((item) => {
        const snippet = evidenceSnippet(item.kind, item.evidence);
        return (
          <div
            key={item.id}
            className={`rounded-2xl border p-5 transition ${item.status === "dismissed" ? "border-white/5 opacity-45" : "border-white/10 bg-white/[0.03]"}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xl">{KIND_ICONS[item.kind]}</span>
                <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${KIND_COLORS[item.kind]}`}>
                  {KIND_LABELS[item.kind]}
                </span>
                {item.status === "actioned" && (
                  <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/40">
                    Actioned
                  </span>
                )}
                {item.status === "dismissed" && (
                  <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white/30">
                    Dismissed
                  </span>
                )}
              </div>
              <span className="text-xs text-white/30">{new Date(item.createdAt).toLocaleDateString()}</span>
            </div>

            <p className="mt-3 text-sm font-semibold leading-snug">{item.title}</p>
            {snippet && <p className="mt-1 text-xs text-white/45">{snippet}</p>}
            <p className="mt-2 text-xs text-white/60">{item.actionHint}</p>

            {item.status === "new" && (
              <div className="mt-4 flex flex-wrap gap-2">
                {item.leadId && (
                  <Link
                    href={`/dashboard/revenue-rescue/leads/${item.leadId}${orgSuffix}`}
                    className="btn-primary px-4 py-2 text-xs"
                    onClick={() => void updateStatus(item.id, "actioned")}
                  >
                    View lead
                  </Link>
                )}
                {!item.leadId && (
                  <button
                    type="button"
                    disabled={busy[item.id]}
                    onClick={() => void updateStatus(item.id, "actioned")}
                    className="btn-primary px-4 py-2 text-xs disabled:opacity-50"
                  >
                    Mark as actioned
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy[item.id]}
                  onClick={() => void updateStatus(item.id, "dismissed")}
                  className="rounded-xl bg-white/5 px-4 py-2 text-xs text-white/55 transition hover:bg-white/10 disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
