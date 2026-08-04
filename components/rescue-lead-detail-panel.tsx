"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CATEGORY_LABELS, type LeadCategory } from "@/lib/rescue-analysis/categories";
import { MANUAL_STAGES, STAGE_LABELS, type PipelineStage } from "@/lib/rescue-engage/pipeline";
import { REPLY_CATEGORY_LABELS } from "@/lib/rescue-engage/replies";
import { APPOINTMENT_STATUS_LABELS, APPOINTMENT_TYPES } from "@/lib/rescue-engage/calendar-adapters";

type Detail = {
  lead: Record<string, unknown> & {
    id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null;
    address: string | null; city: string | null; state: string | null; zip: string | null;
    projectType: string | null; projectDescription: string | null; estimatedValue: number | null;
    source: string | null; sourceDetail: string | null; firstContactDate: string | null; lastContactDate: string | null;
    estimateDate: string | null; consentStatus: string; suppressed: boolean; suppressionReason: string | null;
    notes: string | null; score: number | null; category: string | null; needsReview: boolean;
    analysis: {
      final?: { summary?: string; riskFlags?: string[]; reasonStalled?: string | null; recommendedAction?: string | null; recommendedAngle?: string | null; recommendedChannel?: string | null };
      deterministic?: { signals?: Array<{ key: string; label: string; points: number; detail: string }>; flags?: string[] };
    } | null;
    pipelineStage: string; wonValue: number | null; createdAt: string;
  };
  drafts: Array<{ id: string; messageType: string; tone: string; mode: string; content: Record<string, unknown>; createdAt: string }>;
  engagement: { assignedUserId: string | null; assignedName: string | null; campaigns: Array<{ campaignId: string; name: string; status: string; stopReason: string | null }> } | null;
  messages: Array<{ id: string; direction: string; channel: string; subject: string | null; body: string; status: string; simulated: boolean; replyCategory: string | null; createdAt: string }>;
  activities: Array<{ id: string; title: string; detail: string | null; createdAt: string }>;
  tasks: Array<{ id: string; title: string; detail: string | null; status: string; dueAt: string | null }>;
  appointments: Array<{ id: string; appointmentType: string; scheduledStart: string; status: string; address: string | null }>;
  members: Array<{ userId: string; name: string; role: string }>;
};

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const input = "rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white";

export function RescueLeadDetailPanel({ orgId, leadId, canAct, canManage }: {
  orgId: string; leadId: string; canAct: boolean; canManage: boolean;
}) {
  const searchParams = useSearchParams();
  const orgSuffix = searchParams.get("org") ? `?org=${searchParams.get("org")}` : "";
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [outbound, setOutbound] = useState({ channel: "sms", body: "" });
  const [reply, setReply] = useState({ channel: "sms", body: "" });
  const [appt, setAppt] = useState({ appointmentType: "estimate", scheduledStart: "", address: "" });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/leads/${leadId}`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not load this lead."); return; }
      setData(body);
      setError("");
    } catch { setError("Could not load this lead."); }
  }, [orgId, leadId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  async function act(action: string, extra: Record<string, unknown> = {}, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setNotice("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/leads/${leadId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) setError(body?.error ?? "Action failed."); else { setError(""); await load(); }
    } finally { setBusy(false); }
  }

  async function post(path: string, payload: Record<string, unknown>, successNote: string) {
    setBusy(true); setNotice("");
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Request failed."); return null; }
      setError(""); setNotice(successNote);
      await load();
      return body;
    } finally { setBusy(false); }
  }

  if (error && !data) return <p className="rounded-2xl border border-forge-rust/40 bg-forge-rust/10 p-5 text-sm text-forge-rust">{error}</p>;
  if (!data) return <p className="text-sm text-white/50">Loading lead…</p>;
  const { lead, drafts, engagement, messages, activities, tasks, appointments, members } = data;
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unnamed lead";
  const final = lead.analysis?.final;
  const signals = lead.analysis?.deterministic?.signals ?? [];

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/dashboard/revenue-rescue/leads${orgSuffix}`} className="text-xs text-white/45 hover:text-forge-lime">← Back to leads</Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl font-semibold">{name}</h1>
            <p className="mt-1 text-sm text-white/50">
              {lead.email ?? "No email"} · {lead.phone ?? "No phone"} · {[lead.city, lead.state].filter(Boolean).join(", ") || "No location"}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {lead.suppressed ? (
                <span className="rounded border border-forge-rust/50 px-2 py-0.5 font-bold text-forge-rust">SUPPRESSED{lead.suppressionReason ? ` — ${lead.suppressionReason}` : ""}</span>
              ) : (
                <span className="rounded border border-white/20 px-2 py-0.5">{STAGE_LABELS[lead.pipelineStage as PipelineStage] ?? lead.pipelineStage}</span>
              )}
              <span className="rounded border border-white/20 px-2 py-0.5">Consent: {lead.consentStatus}</span>
              {lead.category && <span className="rounded border border-white/20 px-2 py-0.5">{CATEGORY_LABELS[lead.category as LeadCategory] ?? lead.category}</span>}
              {lead.needsReview && <span className="rounded border border-yellow-400/50 px-2 py-0.5 text-yellow-300">Needs review</span>}
            </div>
          </div>
          <div className="text-right">
            <p className="font-display text-5xl font-semibold text-forge-lime">{lead.score ?? "—"}</p>
            <p className="text-xs text-white/45">opportunity score</p>
            {lead.estimatedValue != null && <p className="mt-1 text-sm font-bold">{money(lead.estimatedValue)} est.</p>}
          </div>
        </div>
      </div>

      {error && <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">{error}</p>}
      {notice && <p className="rounded-xl border border-forge-lime/40 bg-forge-lime/10 px-4 py-3 text-sm text-forge-lime">{notice}</p>}

      {canAct && (
        <div className={`${box} flex flex-wrap items-center gap-3`}>
          {canManage && (
            <label className="flex items-center gap-2 text-xs text-white/55">
              Assigned to
              <select disabled={busy} value={engagement?.assignedUserId ?? ""} onChange={(e) => void act("assign", { userId: e.target.value || null })} className={input}>
                <option value="">Unassigned</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
              </select>
            </label>
          )}
          {!lead.suppressed && (
            <label className="flex items-center gap-2 text-xs text-white/55">
              Stage
              <select
                disabled={busy}
                value={MANUAL_STAGES.includes(lead.pipelineStage as PipelineStage) ? lead.pipelineStage : ""}
                onChange={(e) => {
                  const stage = e.target.value;
                  if (!stage) return;
                  const wonValue = stage === "won" ? window.prompt("Won value in dollars (blank = use estimated value)") : null;
                  void act("stage", { stage, wonValue: wonValue ? Number(wonValue) : undefined });
                }}
                className={input}
              >
                <option value="">{STAGE_LABELS[lead.pipelineStage as PipelineStage] ?? lead.pipelineStage}</option>
                {MANUAL_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
              </select>
            </label>
          )}
          {!lead.suppressed && (
            <button
              disabled={busy}
              onClick={() => void act("suppress", { reason: "Suppressed by team" }, "Suppress this contact? ALL automated outreach stops immediately and this cannot be undone from the dashboard.")}
              className="rounded-lg border border-forge-rust/50 px-3 py-2 text-xs font-bold text-forge-rust hover:bg-forge-rust/10"
            >
              Suppress contact
            </button>
          )}
          <form
            onSubmit={(e) => { e.preventDefault(); if (note.trim()) { void act("note", { note }); setNote(""); } }}
            className="flex flex-1 items-center gap-2"
          >
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" className={`${input} flex-1`} />
            <button type="submit" disabled={busy || !note.trim()} className="btn-secondary px-3 py-2 text-xs disabled:opacity-40">Save note</button>
          </form>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className={box}>
          <h2 className="font-display text-xl font-semibold">Project &amp; history</h2>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div><dt className="text-xs text-white/45">Project type</dt><dd>{lead.projectType ?? "—"}</dd></div>
            <div><dt className="text-xs text-white/45">Source</dt><dd>{lead.source ?? "—"}{lead.sourceDetail ? ` · ${lead.sourceDetail}` : ""}</dd></div>
            <div><dt className="text-xs text-white/45">First contact</dt><dd>{lead.firstContactDate ?? "—"}</dd></div>
            <div><dt className="text-xs text-white/45">Last contact</dt><dd>{lead.lastContactDate ?? "—"}</dd></div>
            <div><dt className="text-xs text-white/45">Estimate date</dt><dd>{lead.estimateDate ?? "—"}</dd></div>
            <div><dt className="text-xs text-white/45">Address</dt><dd>{[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(", ") || "—"}</dd></div>
          </dl>
          {lead.projectDescription && <p className="mt-4 rounded-xl bg-black/30 p-3 text-sm text-white/70">{lead.projectDescription}</p>}
          {lead.notes && <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-black/30 p-3 font-sans text-xs text-white/60">{lead.notes}</pre>}
          {engagement && engagement.campaigns.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-bold uppercase tracking-wider text-white/45">Campaigns</p>
              <ul className="mt-2 space-y-1 text-xs">
                {engagement.campaigns.map((c) => (
                  <li key={c.campaignId}>
                    <Link href={`/dashboard/revenue-rescue/campaigns/${c.campaignId}${orgSuffix}`} className="hover:text-forge-lime">{c.name}</Link>
                    <span className="ml-2 text-white/40">{c.status}{c.stopReason ? ` (${c.stopReason})` : ""}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className={box}>
          <h2 className="font-display text-xl font-semibold">Why this score</h2>
          {final?.summary && <p className="mt-3 text-sm leading-6 text-white/70">{final.summary}</p>}
          {final?.reasonStalled && <p className="mt-2 text-xs text-white/50"><span className="font-bold">Likely stalled because:</span> {final.reasonStalled}</p>}
          {final?.recommendedAction && (
            <p className="mt-2 rounded-xl border border-forge-lime/30 bg-forge-lime/5 p-3 text-sm text-forge-lime">
              Next step: {final.recommendedAction}{final.recommendedChannel ? ` (${final.recommendedChannel})` : ""}
            </p>
          )}
          {signals.length > 0 && (
            <ul className="mt-4 space-y-2">
              {signals.map((s) => (
                <li key={s.key} className="flex items-start justify-between gap-3 text-xs">
                  <div><p className="font-semibold text-white/80">{s.label}</p><p className="text-white/45">{s.detail}</p></div>
                  <span className={`shrink-0 font-bold ${s.points >= 0 ? "text-forge-lime" : "text-forge-rust"}`}>{s.points >= 0 ? `+${s.points}` : s.points}</span>
                </li>
              ))}
            </ul>
          )}
          {(final?.riskFlags?.length ?? 0) > 0 && (
            <p className="mt-3 text-xs text-yellow-300">Risk flags: {final?.riskFlags?.join(", ")}</p>
          )}
          {!final && signals.length === 0 && <p className="mt-3 text-sm text-white/50">This lead hasn&rsquo;t been analyzed yet.</p>}
        </div>
      </div>

      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Conversation</h2>
        {messages.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">No messages yet.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {messages.map((msg) => (
              <li key={msg.id} className={`max-w-[85%] rounded-2xl p-3 text-sm ${msg.direction === "outbound" ? "ml-auto bg-forge-lime/10" : "bg-white/5"}`}>
                <p className="mb-1 text-[10px] uppercase tracking-wider text-white/40">
                  {msg.direction === "outbound" ? "Outbound" : "Inbound"} · {msg.channel}
                  {msg.simulated && <span className="ml-1 rounded border border-yellow-400/50 px-1 font-bold text-yellow-300">SIMULATED — not delivered</span>}
                  {!msg.simulated && msg.direction === "outbound" && <span className="ml-1">({msg.status})</span>}
                  {msg.replyCategory && <span className="ml-1 text-forge-lime">{REPLY_CATEGORY_LABELS[msg.replyCategory as keyof typeof REPLY_CATEGORY_LABELS] ?? msg.replyCategory}</span>}
                  <span className="ml-2">{new Date(msg.createdAt).toLocaleString()}</span>
                </p>
                {msg.subject && <p className="font-semibold">{msg.subject}</p>}
                <p className="whitespace-pre-wrap text-white/80">{msg.body}</p>
              </li>
            ))}
          </ul>
        )}
        {canAct && !lead.suppressed && (
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <form onSubmit={(e) => { e.preventDefault(); if (outbound.body.trim()) { void post(`/api/orgs/${orgId}/leads/${leadId}/thread`, outbound, "Manual message logged."); setOutbound({ ...outbound, body: "" }); } }} className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-white/45">Log a message you sent manually</p>
              <select value={outbound.channel} onChange={(e) => setOutbound({ ...outbound, channel: e.target.value })} className={input}>
                <option value="sms">SMS</option><option value="email">Email</option><option value="call">Call</option>
              </select>
              <textarea value={outbound.body} onChange={(e) => setOutbound({ ...outbound, body: e.target.value })} rows={2} placeholder="What did you send/say?" className={`${input} w-full`} />
              <button type="submit" disabled={busy || !outbound.body.trim()} className="btn-secondary px-3 py-2 text-xs disabled:opacity-40">Log outbound</button>
            </form>
            <form onSubmit={(e) => { e.preventDefault(); if (reply.body.trim()) { void post(`/api/orgs/${orgId}/leads/${leadId}/replies`, reply, "Reply recorded and routed."); setReply({ ...reply, body: "" }); } }} className="space-y-2">
              <p className="text-xs font-bold uppercase tracking-wider text-white/45">Record a reply you received</p>
              <select value={reply.channel} onChange={(e) => setReply({ ...reply, channel: e.target.value })} className={input}>
                <option value="sms">SMS</option><option value="email">Email</option><option value="call">Call</option>
              </select>
              <textarea value={reply.body} onChange={(e) => setReply({ ...reply, body: e.target.value })} rows={2} placeholder="Paste their reply — it will be classified and routed automatically" className={`${input} w-full`} />
              <button type="submit" disabled={busy || !reply.body.trim()} className="btn-secondary px-3 py-2 text-xs disabled:opacity-40">Record reply</button>
            </form>
          </div>
        )}
        {lead.suppressed && <p className="mt-4 text-xs text-forge-rust">This contact is suppressed — outreach and logging are disabled.</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className={box}>
          <h2 className="font-display text-xl font-semibold">Appointments</h2>
          {appointments.length === 0 ? <p className="mt-3 text-sm text-white/50">No appointments for this lead.</p> : (
            <ul className="mt-3 space-y-2 text-sm">
              {appointments.map((a) => (
                <li key={a.id} className="rounded-xl bg-black/30 p-3">
                  <span className="font-semibold capitalize">{a.appointmentType.replace("_", " ")}</span>
                  <span className="ml-2 text-white/55">{new Date(a.scheduledStart).toLocaleString()}</span>
                  <span className="ml-2 rounded border border-white/20 px-1.5 py-0.5 text-[10px] uppercase">{APPOINTMENT_STATUS_LABELS[a.status as keyof typeof APPOINTMENT_STATUS_LABELS] ?? a.status}</span>
                </li>
              ))}
            </ul>
          )}
          {canAct && !lead.suppressed && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!appt.scheduledStart) return;
                void post(`/api/orgs/${orgId}/appointments`, { leadId, ...appt, scheduledStart: new Date(appt.scheduledStart).toISOString() }, "Appointment booked.");
                setAppt({ appointmentType: "estimate", scheduledStart: "", address: "" });
              }}
              className="mt-4 flex flex-wrap items-end gap-2"
            >
              <select value={appt.appointmentType} onChange={(e) => setAppt({ ...appt, appointmentType: e.target.value })} className={input}>
                {APPOINTMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
              </select>
              <input type="datetime-local" value={appt.scheduledStart} onChange={(e) => setAppt({ ...appt, scheduledStart: e.target.value })} className={input} required />
              <input value={appt.address} onChange={(e) => setAppt({ ...appt, address: e.target.value })} placeholder="Address (optional)" className={input} />
              <button type="submit" disabled={busy || !appt.scheduledStart} className="btn-secondary px-3 py-2 text-xs disabled:opacity-40">Book appointment</button>
            </form>
          )}
        </div>

        <div className={box}>
          <h2 className="font-display text-xl font-semibold">Follow-up tasks</h2>
          {tasks.length === 0 ? <p className="mt-3 text-sm text-white/50">No tasks for this lead.</p> : (
            <ul className="mt-3 space-y-2 text-sm">
              {tasks.map((t) => (
                <li key={t.id} className={`flex items-start justify-between gap-3 rounded-xl bg-black/30 p-3 ${t.status !== "open" ? "opacity-50" : ""}`}>
                  <div>
                    <p className="font-semibold">{t.title}</p>
                    {t.detail && <p className="text-xs text-white/45">{t.detail}</p>}
                    {t.dueAt && <p className="text-[10px] text-white/40">Due {new Date(t.dueAt).toLocaleDateString()}</p>}
                  </div>
                  {t.status === "open" && canAct && (
                    <button
                      disabled={busy}
                      onClick={async () => { await fetch(`/api/orgs/${orgId}/tasks/${t.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "done" }) }); await load(); }}
                      className="btn-secondary shrink-0 px-2.5 py-1 text-[10px]"
                    >
                      Done
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {drafts.length > 0 && (
        <div className={box}>
          <h2 className="font-display text-xl font-semibold">Generated drafts</h2>
          <ul className="mt-3 space-y-3">
            {drafts.slice(0, 5).map((d) => (
              <li key={d.id} className="rounded-xl bg-black/30 p-3 text-sm">
                <p className="mb-1 text-[10px] uppercase tracking-wider text-white/40">{d.messageType} · {d.tone} · {d.mode} · {new Date(d.createdAt).toLocaleString()}</p>
                {typeof d.content.subject === "string" && <p className="font-semibold">{d.content.subject}</p>}
                <p className="whitespace-pre-wrap text-white/75">{typeof d.content.body === "string" ? d.content.body : typeof d.content.script === "string" ? d.content.script : typeof d.content.note === "string" ? d.content.note : JSON.stringify(d.content, null, 2)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <CloserBriefingCard orgId={orgId} leadId={leadId} />

      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Timeline</h2>
        {activities.length === 0 ? <p className="mt-3 text-sm text-white/50">No activity recorded yet.</p> : (
          <ul className="mt-3 divide-y divide-white/5">
            {activities.map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-4 py-2">
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

type BriefingData = { briefingText: string | null; generatedAt: string; error: string | null } | null;

function CloserBriefingCard({ orgId, leadId }: { orgId: string; leadId: string }) {
  const [open, setOpen] = useState(false);
  const [briefing, setBriefing] = useState<BriefingData>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const fetchBriefing = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/leads/${leadId}/briefing`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (res.ok) setBriefing(body.briefing as BriefingData);
    } finally {
      setLoading(false);
    }
  }, [orgId, leadId]);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/leads/${leadId}/briefing`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (res.ok) setBriefing(body.briefing as BriefingData);
    } finally {
      setGenerating(false);
    }
  }, [orgId, leadId]);

  function toggle() {
    setOpen((o) => {
      if (!o && !briefing && !loading) void Promise.resolve().then(fetchBriefing);
      return !o;
    });
  }

  return (
    <div className={box}>
      <button type="button" onClick={toggle} className="flex w-full items-center justify-between gap-2">
        <h2 className="font-display text-xl font-semibold">Closer briefing</h2>
        <span className="text-xs text-white/40">{open ? "▲ collapse" : "▼ expand"}</span>
      </button>
      {open && (
        <div className="mt-4">
          {loading && <p className="text-sm text-white/50">Loading…</p>}
          {!loading && !briefing && (
            <p className="text-sm text-white/50">No briefing generated yet.</p>
          )}
          {!loading && briefing?.error && (
            <p className="text-sm text-forge-rust">{briefing.error}</p>
          )}
          {!loading && briefing?.briefingText && (
            <div className="space-y-1">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/85">{briefing.briefingText}</p>
              <p className="text-xs text-white/30">Generated {new Date(briefing.generatedAt).toLocaleString()}</p>
            </div>
          )}
          <button
            type="button"
            disabled={generating}
            onClick={() => void generate()}
            className="mt-4 rounded-xl bg-white/5 px-4 py-2 text-xs text-white/55 transition hover:bg-white/10 disabled:opacity-50"
          >
            {generating ? "Generating…" : briefing ? "Regenerate" : "Generate briefing"}
          </button>
          <p className="mt-2 text-[11px] text-white/30">
            Uses AI to summarize why this lead deserves attention and the best approach to take.
          </p>
        </div>
      )}
    </div>
  );
}
