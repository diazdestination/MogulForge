"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CAMPAIGN_TEMPLATES } from "@/lib/rescue-engage/campaign-templates";
import { APPROVAL_MODE_LABELS, APPROVAL_MODES, STOP_CONDITION_LABELS, STOP_CONDITIONS } from "@/lib/rescue-engage/campaign-schema";
import { LEAD_CATEGORIES, CATEGORY_LABELS, NO_OUTREACH_CATEGORIES } from "@/lib/rescue-analysis/categories";
import { initialCampaignForm, type CampaignFormState, type MessagingDefaults } from "@/lib/rescue-engage/campaign-prefill";

type CampaignRow = {
  id: string; name: string; channel: string; tone: string; mode: string; status: string;
  templateKey: string | null; createdAt: string;
  stats: { enrolled: number; messaged: number; simulatedSends: number; delivered: number; replies: number; optOuts: number; appointments: number; pipelineValue: number };
};

type Provider = { connected: boolean; label: string; detail: string };

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const input = "rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white";

export function RescueCampaignsPanel({ orgId }: { orgId: string }) {
  const searchParams = useSearchParams();
  const orgSuffix = searchParams.get("org") ? `?org=${searchParams.get("org")}` : "";
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [providers, setProviders] = useState<{ sms: Provider; email: Provider } | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [defaults, setDefaults] = useState<MessagingDefaults | null>(null);
  const [building, setBuilding] = useState<CampaignFormState | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/campaigns`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not load campaigns."); return; }
      setCampaigns(body.campaigns);
      setProviders(body.providers);
      setCanManage(body.canManage === true);
      setError("");
    } catch { setError("Could not load campaigns."); }
  }, [orgId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  // Saved messaging defaults prefill new campaigns (best-effort; the form
  // falls back to its built-in defaults when this hasn't loaded or fails).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/orgs/${orgId}/settings`, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (!cancelled && res.ok && body?.settings?.messaging) setDefaults(body.settings.messaging as MessagingDefaults);
      } catch { /* keep built-in defaults */ }
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  function startFromTemplate(key: string | null) {
    const t = key ? CAMPAIGN_TEMPLATES.find((x) => x.key === key) ?? null : null;
    setBuilding(initialCampaignForm(t, defaults));
  }

  async function create() {
    if (!building) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: building.name,
          templateKey: building.templateKey,
          objective: building.objective,
          channel: building.channel,
          tone: building.tone,
          approvalMode: building.approvalMode,
          followUpDelayDays: building.followUpDelayDays,
          maxAttempts: building.maxAttempts,
          stopConditions: building.stopConditions,
          senderIdentity: building.senderIdentity || null,
          bookingLink: building.bookingLink || null,
          audience: {
            categories: building.categories,
            minScore: building.minScore === "" ? null : Number(building.minScore),
          },
          schedule: {
            startDate: building.startDate || null,
            quietHoursStart: building.quietHoursStart,
            quietHoursEnd: building.quietHoursEnd,
          },
        }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not create the campaign."); return; }
      setBuilding(null);
      setError("");
      await load();
    } finally { setBusy(false); }
  }

  const simulationOnly = providers && !providers.sms.connected && !providers.email.connected;

  return (
    <div className="space-y-6">
      {simulationOnly && (
        <div className="rounded-2xl border border-yellow-400/40 bg-yellow-400/10 px-5 py-4 text-sm text-yellow-200">
          <span className="font-bold uppercase tracking-wide">Simulation Mode</span> — no SMS or email provider is connected.
          Campaigns can be built, previewed, and activated safely: sends are recorded as simulated and nothing reaches a customer.
        </div>
      )}
      {error && <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">{error}</p>}

      {canManage && !building && (
        <div className={box}>
          <div className="flex items-center justify-between">
            <h2 className="font-display text-xl font-semibold">Start from a template</h2>
            <button onClick={() => startFromTemplate(null)} className="btn-secondary px-3 py-2 text-xs">Blank campaign</button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {CAMPAIGN_TEMPLATES.map((t) => (
              <button key={t.key} onClick={() => startFromTemplate(t.key)} className="rounded-xl border border-white/10 bg-black/30 p-4 text-left transition hover:border-forge-lime/50">
                <p className="text-sm font-semibold">{t.name}</p>
                <p className="mt-1 text-xs leading-5 text-white/50">{t.description}</p>
                <p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-forge-lime">{t.channel} · {t.tone}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {building && (
        <div className={box}>
          <h2 className="font-display text-xl font-semibold">{building.templateKey ? "Customize campaign" : "New campaign"}</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="block text-xs text-white/55">Name
              <input value={building.name} onChange={(e) => setBuilding({ ...building, name: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Campaign name" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-white/55">Channel
                <select value={building.channel} onChange={(e) => setBuilding({ ...building, channel: e.target.value as "sms" | "email" })} className={`${input} mt-1 w-full`}>
                  <option value="sms">SMS</option><option value="email">Email</option>
                </select>
              </label>
              <label className="block text-xs text-white/55">Tone
                <select value={building.tone} onChange={(e) => setBuilding({ ...building, tone: e.target.value })} className={`${input} mt-1 w-full`}>
                  <option value="professional">Professional</option><option value="friendly">Friendly</option><option value="urgent">Urgent</option>
                </select>
              </label>
            </div>
            <label className="block text-xs text-white/55">Sender name
              <input value={building.senderIdentity} onChange={(e) => setBuilding({ ...building, senderIdentity: e.target.value })} className={`${input} mt-1 w-full`} placeholder="Who messages come from" />
            </label>
            <div className="block text-xs text-white/55">
              <div className="flex items-center justify-between">
                <span>Booking link</span>
                <button
                  type="button"
                  onClick={() => setBuilding({ ...building, bookingLink: "{{booking_link}}" })}
                  className="rounded border border-forge-lime/50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-forge-lime transition hover:bg-forge-lime/10"
                  title="Use your booking page — resolved per lead at send time"
                >
                  Insert booking link
                </button>
              </div>
              <input value={building.bookingLink} onChange={(e) => setBuilding({ ...building, bookingLink: e.target.value })} className={`${input} mt-1 w-full`} placeholder="https://calendly.com/…" />
              <p className="mt-1 text-[10px] text-white/40">
                {building.bookingLink.trim().toLowerCase() === "{{booking_link}}"
                  ? "Messages will include your booking page, minted per lead at send time (falls back to your saved Calendly link)."
                  : "Paste a URL, or click Insert booking link to auto-resolve your booking page per lead at send time."}
              </p>
            </div>
            <label className="block text-xs text-white/55 md:col-span-2">Objective
              <input value={building.objective} onChange={(e) => setBuilding({ ...building, objective: e.target.value })} className={`${input} mt-1 w-full`} placeholder="What should this campaign accomplish?" />
            </label>
            <div className="md:col-span-2">
              <p className="text-xs text-white/55">Audience categories (do-not-contact and invalid leads are always excluded)</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {LEAD_CATEGORIES.filter((c) => !NO_OUTREACH_CATEGORIES.includes(c)).map((c) => {
                  const on = building.categories.includes(c);
                  return (
                    <button key={c} type="button" onClick={() => setBuilding({ ...building, categories: on ? building.categories.filter((x) => x !== c) : [...building.categories, c] })}
                      className={`rounded-full border px-3 py-1.5 text-xs ${on ? "border-forge-lime text-forge-lime" : "border-white/15 text-white/50"}`}>
                      {CATEGORY_LABELS[c]}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[10px] text-white/40">No categories selected = all contactable categories.</p>
            </div>
            <label className="block text-xs text-white/55">Minimum score
              <input type="number" min={0} max={100} value={building.minScore} onChange={(e) => setBuilding({ ...building, minScore: e.target.value })} className={`${input} mt-1 w-full`} placeholder="No minimum" />
            </label>
            <label className="block text-xs text-white/55">Approval mode
              <select value={building.approvalMode} onChange={(e) => setBuilding({ ...building, approvalMode: e.target.value })} className={`${input} mt-1 w-full`}>
                {APPROVAL_MODES.map((m) => <option key={m} value={m}>{APPROVAL_MODE_LABELS[m]}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-3 gap-3">
              <label className="block text-xs text-white/55">Start date
                <input type="date" value={building.startDate} onChange={(e) => setBuilding({ ...building, startDate: e.target.value })} className={`${input} mt-1 w-full`} />
              </label>
              <label className="block text-xs text-white/55">Quiet from
                <input type="number" min={0} max={23} value={building.quietHoursStart} onChange={(e) => setBuilding({ ...building, quietHoursStart: Number(e.target.value) })} className={`${input} mt-1 w-full`} />
              </label>
              <label className="block text-xs text-white/55">Quiet until
                <input type="number" min={0} max={23} value={building.quietHoursEnd} onChange={(e) => setBuilding({ ...building, quietHoursEnd: Number(e.target.value) })} className={`${input} mt-1 w-full`} />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs text-white/55">Follow-up delay (days)
                <input type="number" min={0} max={60} value={building.followUpDelayDays} onChange={(e) => setBuilding({ ...building, followUpDelayDays: Number(e.target.value) })} className={`${input} mt-1 w-full`} />
              </label>
              <label className="block text-xs text-white/55">Max attempts
                <input type="number" min={1} max={10} value={building.maxAttempts} onChange={(e) => setBuilding({ ...building, maxAttempts: Number(e.target.value) })} className={`${input} mt-1 w-full`} />
              </label>
            </div>
            <div className="md:col-span-2">
              <p className="text-xs text-white/55">Stop conditions</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {STOP_CONDITIONS.map((s) => {
                  const on = building.stopConditions.includes(s);
                  const locked = s === "opt_out";
                  return (
                    <button key={s} type="button" disabled={locked}
                      onClick={() => setBuilding({ ...building, stopConditions: on ? building.stopConditions.filter((x) => x !== s) : [...building.stopConditions, s] })}
                      className={`rounded-full border px-3 py-1.5 text-xs ${on ? "border-forge-lime text-forge-lime" : "border-white/15 text-white/50"} ${locked ? "cursor-not-allowed opacity-80" : ""}`}>
                      {STOP_CONDITION_LABELS[s]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="mt-5 flex gap-3">
            <button onClick={() => void create()} disabled={busy || !building.name.trim()} className="btn-primary px-4 py-2 text-xs disabled:opacity-40">Save draft</button>
            <button onClick={() => setBuilding(null)} className="btn-secondary px-4 py-2 text-xs">Cancel</button>
          </div>
        </div>
      )}

      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Your campaigns</h2>
        {campaigns.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">No campaigns yet.{canManage ? " Pick a template above to create your first one." : ""}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-[10px] uppercase tracking-wider text-white/40">
                <tr><th className="pb-2">Campaign</th><th className="pb-2">Mode</th><th className="pb-2">Status</th><th className="pb-2 text-right">Enrolled</th><th className="pb-2 text-right">Simulated</th><th className="pb-2 text-right">Replies</th><th className="pb-2 text-right">Opt-outs</th><th className="pb-2 text-right">Pipeline</th></tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {campaigns.map((c) => (
                  <tr key={c.id}>
                    <td className="py-3 pr-3">
                      <Link href={`/dashboard/revenue-rescue/campaigns/${c.id}${orgSuffix}`} className="font-semibold hover:text-forge-lime">{c.name}</Link>
                      <p className="text-xs text-white/40">{c.channel.toUpperCase()} · {c.tone}</p>
                    </td>
                    <td className="py-3 pr-3">
                      {c.mode === "simulation"
                        ? <span className="rounded border border-yellow-400/50 px-1.5 py-0.5 text-[10px] font-bold text-yellow-300">SIMULATION</span>
                        : <span className="rounded border border-forge-lime/50 px-1.5 py-0.5 text-[10px] font-bold text-forge-lime">LIVE</span>}
                    </td>
                    <td className="py-3 pr-3 text-xs capitalize">{c.status}</td>
                    <td className="py-3 text-right">{c.stats.enrolled}</td>
                    <td className="py-3 text-right">{c.stats.simulatedSends}</td>
                    <td className="py-3 text-right">{c.stats.replies}</td>
                    <td className="py-3 text-right">{c.stats.optOuts}</td>
                    <td className="py-3 text-right">${Math.round(c.stats.pipelineValue).toLocaleString()}</td>
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
