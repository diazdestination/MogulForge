"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { APPROVAL_MODE_LABELS, STOP_CONDITION_LABELS, type ApprovalMode, type StopCondition } from "@/lib/rescue-engage/campaign-schema";
import { CATEGORY_LABELS, type LeadCategory } from "@/lib/rescue-analysis/categories";
import { STAGE_LABELS, type PipelineStage } from "@/lib/rescue-engage/pipeline";

type Campaign = {
  id: string; name: string; templateKey: string | null; objective: string; channel: "sms" | "email";
  tone: string; mode: string; status: string; approvalMode: ApprovalMode;
  audience: { categories: LeadCategory[]; minScore: number | null; sources: string[]; projectTypes: string[]; dormantDaysMin: number | null };
  schedule: { startDate: string | null; quietHoursStart: number; quietHoursEnd: number };
  stopConditions: StopCondition[]; followUpDelayDays: number; maxAttempts: number;
  activatedAt: string | null; createdAt: string;
};

type Preview = {
  accounting: {
    poolTotal: number; eligible: number; suppressed: number; optedOut: number; doNotContact: number;
    invalidDuplicate: number; closedStage: number; invalidContact: number; alreadyEnrolled: number; missingConsent: number;
  };
  samples: Array<{ leadName: string; subject: string | null; body: string }>;
  sendDraftMode?: "ai" | "template";
};

type EnrolledLead = {
  leadId: string; firstName: string | null; lastName: string | null; score: number | null;
  status: string; pipelineStage: string; stopReason: string | null; enrolledAt: string;
  attempts: number; lastMessageAt: string | null;
};

type DetailResponse = {
  campaign: Campaign;
  stats: { enrolled: number; messaged: number; simulatedSends: number; delivered: number; replies: number; optOuts: number; appointments: number; pipelineValue: number };
  leads: EnrolledLead[];
  provider: { connected: boolean; label: string; detail: string };
  canManage: boolean;
};

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";

export function RescueCampaignDetailPanel({ orgId, campaignId }: { orgId: string; campaignId: string }) {
  const searchParams = useSearchParams();
  const orgSuffix = searchParams.get("org") ? `?org=${searchParams.get("org")}` : "";
  const [data, setData] = useState<DetailResponse | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/campaigns/${campaignId}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not load this campaign."); return; }
      setData(body);
      setError("");
    } catch { setError("Could not load this campaign."); }
  }, [orgId, campaignId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function loadPreview() {
    setBusy(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/campaigns/${campaignId}/preview`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Preview failed."); return; }
      setPreview(body);
      setError("");
    } finally { setBusy(false); }
  }

  async function activate() {
    if (!confirmChecked) return;
    setBusy(true); setNotice("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/campaigns/${campaignId}/activate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "simulation", confirm: true }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Activation failed."); return; }
      setError("");
      setNotice(`Campaign activated in Simulation Mode: ${body.enrolled} lead(s) enrolled, ${body.simulatedSends} simulated send(s) recorded. Nothing was delivered to customers.`);
      setConfirming(false);
      setConfirmChecked(false);
      setPreview(null);
      await load();
    } finally { setBusy(false); }
  }

  async function patch(action: string) {
    setBusy(true); setNotice("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/campaigns/${campaignId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Update failed."); return; }
      setError("");
      await load();
    } finally { setBusy(false); }
  }

  if (error && !data) return <p className="rounded-2xl border border-forge-rust/40 bg-forge-rust/10 p-5 text-sm text-forge-rust">{error}</p>;
  if (!data) return <p className="text-sm text-white/50">Loading campaign…</p>;
  const { campaign: c, stats, leads, provider, canManage } = data;

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/dashboard/revenue-rescue/campaigns${orgSuffix}`} className="text-xs text-white/45 hover:text-forge-lime">← Back to campaigns</Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl font-semibold">{c.name}</h1>
            <p className="mt-2 text-sm text-white/55">{c.objective}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded border border-white/20 px-2 py-0.5 uppercase">{c.channel}</span>
              <span className="rounded border border-white/20 px-2 py-0.5 capitalize">{c.tone}</span>
              <span className="rounded border border-white/20 px-2 py-0.5 capitalize">{c.status}</span>
              {c.mode === "simulation"
                ? <span className="rounded border border-yellow-400/50 px-2 py-0.5 font-bold text-yellow-300">SIMULATION MODE — no real messages are sent</span>
                : <span className="rounded border border-forge-lime/50 px-2 py-0.5 font-bold text-forge-lime">LIVE</span>}
              <span className="rounded border border-white/20 px-2 py-0.5">{APPROVAL_MODE_LABELS[c.approvalMode]}</span>
            </div>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {(c.status === "draft" || c.status === "paused") && (
                <button onClick={() => { setConfirming(true); void loadPreview(); }} disabled={busy} className="btn-primary px-4 py-2 text-xs">
                  {c.status === "paused" ? "Resume" : "Activate"}…
                </button>
              )}
              {c.status === "active" && <button onClick={() => void patch("pause")} disabled={busy} className="btn-secondary px-4 py-2 text-xs">Pause</button>}
              {(c.status === "active" || c.status === "paused") && <button onClick={() => void patch("complete")} disabled={busy} className="btn-secondary px-4 py-2 text-xs">Mark complete</button>}
              {(c.status === "completed" || c.status === "draft") && <button onClick={() => void patch("archive")} disabled={busy} className="btn-secondary px-4 py-2 text-xs">Archive</button>}
            </div>
          )}
        </div>
      </div>

      {error && <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">{error}</p>}
      {notice && <p className="rounded-xl border border-forge-lime/40 bg-forge-lime/10 px-4 py-3 text-sm text-forge-lime">{notice}</p>}

      {!provider.connected && (
        <div className="rounded-2xl border border-yellow-400/40 bg-yellow-400/10 px-5 py-4 text-sm text-yellow-200">
          <span className="font-bold">{provider.label}:</span> {provider.detail} Activation runs in Simulation Mode — simulated sends are recorded but never delivered, and are never reported as delivered.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Enrolled", value: stats.enrolled },
          { label: "Simulated sends", value: stats.simulatedSends },
          { label: "Delivered (live)", value: stats.delivered },
          { label: "Replies", value: stats.replies },
          { label: "Opt-outs", value: stats.optOuts },
          { label: "Appointments", value: stats.appointments },
          { label: "Pipeline value", value: `$${Math.round(stats.pipelineValue).toLocaleString()}` },
          { label: "Messaged", value: stats.messaged },
        ].map((card) => (
          <div key={card.label} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-white/45">{card.label}</p>
            <p className="mt-1 font-display text-2xl font-semibold">{card.value}</p>
          </div>
        ))}
      </div>

      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Audience &amp; rules</h2>
        <dl className="mt-4 grid gap-x-4 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-white/45">Categories</dt><dd>{c.audience.categories.length ? c.audience.categories.map((k) => CATEGORY_LABELS[k]).join(", ") : "All contactable categories"}</dd></div>
          <div><dt className="text-xs text-white/45">Minimum score</dt><dd>{c.audience.minScore ?? "None"}</dd></div>
          <div><dt className="text-xs text-white/45">Schedule</dt><dd>{c.schedule.startDate ?? "Starts on activation"} · quiet hours {c.schedule.quietHoursStart}:00–{c.schedule.quietHoursEnd}:00</dd></div>
          <div><dt className="text-xs text-white/45">Follow-ups</dt><dd>Every {c.followUpDelayDays} day(s), max {c.maxAttempts} attempt(s)</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-white/45">Stop conditions</dt><dd>{c.stopConditions.map((s) => STOP_CONDITION_LABELS[s]).join(" · ")}</dd></div>
        </dl>
      </div>

      {confirming && (
        <div className="rounded-2xl border border-forge-lime/40 bg-forge-lime/5 p-6">
          <h2 className="font-display text-xl font-semibold">Pre-activation preview</h2>
          {!preview ? (
            <p className="mt-3 text-sm text-white/50">Computing eligibility…</p>
          ) : (
            <>
              <div className="mt-4 grid gap-3 text-center sm:grid-cols-4 lg:grid-cols-8">
                {[
                  { label: "Matched filters", value: preview.accounting.poolTotal, tone: "" },
                  { label: "Eligible", value: preview.accounting.eligible, tone: "text-forge-lime" },
                  { label: "Suppressed", value: preview.accounting.suppressed, tone: "text-forge-rust" },
                  { label: "Opted out", value: preview.accounting.optedOut, tone: "text-forge-rust" },
                  { label: "Do not contact", value: preview.accounting.doNotContact, tone: "text-forge-rust" },
                  { label: "Invalid/duplicate", value: preview.accounting.invalidDuplicate, tone: "text-white/50" },
                  { label: "No valid contact", value: preview.accounting.invalidContact, tone: "text-white/50" },
                  { label: "Already enrolled", value: preview.accounting.alreadyEnrolled, tone: "text-white/50" },
                ].map((cell) => (
                  <div key={cell.label} className="rounded-xl bg-black/30 p-3">
                    <p className={`font-display text-2xl font-semibold ${cell.tone}`}>{cell.value}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-wider text-white/45">{cell.label}</p>
                  </div>
                ))}
              </div>
              {preview.accounting.missingConsent > 0 && (
                <p className="mt-2 text-xs text-yellow-300">{preview.accounting.missingConsent} eligible lead(s) have unknown consent status — review before ever going live.</p>
              )}
              {preview.samples.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-bold uppercase tracking-wider text-white/45">Sample messages</p>
                  {preview.sendDraftMode === "ai" && (
                    <p className="mt-1 text-xs text-white/50">These samples are quick template previews. Actual sends will be AI-personalized from each lead's stored facts (falling back to this template if AI is unavailable), always including opt-out language.</p>
                  )}
                  <ul className="mt-2 space-y-2">
                    {preview.samples.map((s, i) => (
                      <li key={i} className="rounded-xl bg-black/30 p-3 text-sm">
                        <p className="text-[10px] uppercase tracking-wider text-white/40">To {s.leadName}</p>
                        {s.subject && <p className="font-semibold">{s.subject}</p>}
                        <p className="whitespace-pre-wrap text-white/75">{s.body}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-5 rounded-xl border border-yellow-400/40 bg-yellow-400/10 p-4 text-sm text-yellow-200">
                {provider.connected
                  ? "A live provider is connected. Live sending still requires a separate explicit confirmation."
                  : "No provider is connected, so this activation is Simulation Mode only: simulated sends are recorded for review and nothing is delivered to customers."}
              </div>
              <label className="mt-4 flex items-start gap-2 text-sm">
                <input type="checkbox" checked={confirmChecked} onChange={(e) => setConfirmChecked(e.target.checked)} className="mt-1" />
                <span>I reviewed the audience accounting above and confirm activating this campaign for <span className="font-bold text-forge-lime">{preview.accounting.eligible}</span> eligible lead(s) in {provider.connected ? "the selected mode" : "Simulation Mode"}.</span>
              </label>
              <div className="mt-4 flex gap-3">
                <button onClick={() => void activate()} disabled={busy || !confirmChecked || preview.accounting.eligible === 0} className="btn-primary px-4 py-2 text-xs disabled:opacity-40">
                  Activate in Simulation Mode
                </button>
                <button onClick={() => { setConfirming(false); setPreview(null); setConfirmChecked(false); }} className="btn-secondary px-4 py-2 text-xs">Cancel</button>
              </div>
              {preview.accounting.eligible === 0 && <p className="mt-2 text-xs text-white/45">No eligible leads — widen the audience filters or import more leads.</p>}
            </>
          )}
        </div>
      )}

      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Enrolled leads</h2>
        {leads.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">No leads enrolled yet. Activation enrolls every eligible lead from the audience preview.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-white/40">
                <tr><th className="pb-2">Lead</th><th className="pb-2">Score</th><th className="pb-2">Enrollment</th><th className="pb-2">Stage</th><th className="pb-2">Attempts</th><th className="pb-2">Last message</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {leads.map((l) => (
                  <tr key={l.leadId}>
                    <td className="py-2.5 pr-3">
                      <Link href={`/dashboard/revenue-rescue/leads/${l.leadId}${orgSuffix}`} className="font-semibold hover:text-forge-lime">
                        {[l.firstName, l.lastName].filter(Boolean).join(" ") || "Unnamed lead"}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 text-forge-lime">{l.score ?? "—"}</td>
                    <td className="py-2.5 pr-3 text-xs capitalize">{l.status}{l.stopReason ? ` (${l.stopReason})` : ""}</td>
                    <td className="py-2.5 pr-3 text-xs">{STAGE_LABELS[l.pipelineStage as PipelineStage] ?? l.pipelineStage}</td>
                    <td className="py-2.5 pr-3 text-xs">{l.attempts > 0 ? `${l.attempts} of ${data.campaign.maxAttempts}` : "—"}</td>
                    <td className="py-2.5 text-xs text-white/45">{l.lastMessageAt ? new Date(l.lastMessageAt).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
