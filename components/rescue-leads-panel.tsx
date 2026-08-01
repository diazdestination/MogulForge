"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LEAD_CATEGORIES, CATEGORY_LABELS, type LeadCategory } from "@/lib/rescue-analysis/categories";
import { MANUAL_STAGES, PIPELINE_STAGES, STAGE_LABELS, type PipelineStage } from "@/lib/rescue-engage/pipeline";

type LeadRow = {
  id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null;
  city: string | null; state: string | null; projectType: string | null; estimatedValue: number | null;
  source: string | null; suppressed: boolean; score: number | null; category: string | null;
  needsReview: boolean; createdAt: string; pipelineStage: string; assignedUserId: string | null;
  assignedName: string | null; lastContactDate: string | null;
};

type Member = { userId: string; name: string; role: string };

const PAGE_SIZE = 25;
const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

export function RescueLeadsPanel({ orgId, canAct, canManage, initialCampaignId }: {
  orgId: string; canAct: boolean; canManage: boolean; initialCampaignId: string | null;
}) {
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [members, setMembers] = useState<Member[]>([]);
  const [options, setOptions] = useState<{ sources: string[]; projectTypes: string[] }>({ sources: [], projectTypes: [] });
  const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [scoped, setScoped] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Filters
  const [search, setSearch] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [category, setCategory] = useState("");
  const [minScore, setMinScore] = useState("");
  const [stage, setStage] = useState("");
  const [source, setSource] = useState("");
  const [projectType, setProjectType] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [campaignId, setCampaignId] = useState(initialCampaignId ?? "");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [sort, setSort] = useState("score");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const query = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE), sort, dir });
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    if (minScore) params.set("minScore", minScore);
    if (stage) params.set("stage", stage);
    if (source) params.set("source", source);
    if (projectType) params.set("projectType", projectType);
    if (assignedTo) params.set("assignedTo", assignedTo);
    if (campaignId) params.set("campaignId", campaignId);
    if (createdFrom) params.set("createdFrom", createdFrom);
    if (createdTo) params.set("createdTo", createdTo);
    return params.toString();
  }, [page, sort, dir, search, category, minScore, stage, source, projectType, assignedTo, campaignId, createdFrom, createdTo]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/leads?${query}`, { cache: "no-store" });
      if (!res.ok) {
        setError((await res.json().catch(() => null))?.error ?? "Could not load leads.");
        return;
      }
      const body = await res.json();
      setLeads(body.leads);
      setTotal(body.total);
      setMembers(body.members ?? []);
      setOptions(body.options ?? { sources: [], projectTypes: [] });
      setScoped(body.scopedToAssigned === true);
      setError("");
    } catch {
      setError("Could not load leads.");
    }
  }, [orgId, query]);

  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  useEffect(() => {
    // Campaign list feeds the "add to campaign" bulk action + filter labels.
    fetch(`/api/orgs/${orgId}/campaigns`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (body) setCampaigns(body.campaigns.map((c: { id: string; name: string; status: string }) => ({ id: c.id, name: c.name, status: c.status }))); })
      .catch(() => {});
  }, [orgId]);

  const allSelected = leads.length > 0 && leads.every((l) => selected.has(l.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)));
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function bulk(action: string, extra: Record<string, unknown> = {}) {
    if (selected.size === 0) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/leads/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, leadIds: [...selected], ...extra }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Bulk action failed.");
      } else {
        setNotice(`${body.affected} lead${body.affected === 1 ? "" : "s"} updated${body.skipped ? ` · ${body.skipped} skipped (suppressed, opted out, or missing contact info)` : ""}.`);
        setSelected(new Set());
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const sel = "rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs text-white";

  function resetPage<T>(setter: (v: T) => void) {
    return (v: T) => { setter(v); setPage(0); setSelected(new Set()); };
  }

  return (
    <div className="space-y-4">
      {scoped && <p className="text-xs text-white/45">Showing your assigned leads only.</p>}
      {error && <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">{error}</p>}
      {notice && <p className="rounded-xl border border-forge-lime/40 bg-forge-lime/10 px-4 py-3 text-sm text-forge-lime">{notice}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={(e) => { e.preventDefault(); resetPage(setSearch)(searchDraft); }} className="flex gap-2">
          <input value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} placeholder="Search name, email, phone, address…" className={`${sel} w-64`} />
          <button type="submit" className="btn-secondary px-3 py-1.5 text-xs">Search</button>
        </form>
        <select value={category} onChange={(e) => resetPage(setCategory)(e.target.value)} className={sel}>
          <option value="">All categories</option>
          {LEAD_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c as LeadCategory]}</option>)}
        </select>
        <select value={minScore} onChange={(e) => resetPage(setMinScore)(e.target.value)} className={sel}>
          <option value="">Any score</option>
          <option value="70">Score ≥ 70</option>
          <option value="50">Score ≥ 50</option>
          <option value="30">Score ≥ 30</option>
        </select>
        <select value={stage} onChange={(e) => resetPage(setStage)(e.target.value)} className={sel}>
          <option value="">All stages</option>
          {PIPELINE_STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
        </select>
        <select value={source} onChange={(e) => resetPage(setSource)(e.target.value)} className={sel}>
          <option value="">All sources</option>
          {options.sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={projectType} onChange={(e) => resetPage(setProjectType)(e.target.value)} className={sel}>
          <option value="">All projects</option>
          {options.projectTypes.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={assignedTo} onChange={(e) => resetPage(setAssignedTo)(e.target.value)} className={sel}>
          <option value="">Any assignee</option>
          <option value="none">Unassigned</option>
          {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
        </select>
        <select value={campaignId} onChange={(e) => resetPage(setCampaignId)(e.target.value)} className={sel}>
          <option value="">Any campaign</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={createdFrom} onChange={(e) => resetPage(setCreatedFrom)(e.target.value)} className={sel} title="Imported from" />
        <input type="date" value={createdTo} onChange={(e) => resetPage(setCreatedTo)(e.target.value)} className={sel} title="Imported to" />
        <select value={`${sort}:${dir}`} onChange={(e) => { const [s, d] = e.target.value.split(":"); setSort(s); setDir(d as "asc" | "desc"); setPage(0); }} className={sel}>
          <option value="score:desc">Score (high → low)</option>
          <option value="score:asc">Score (low → high)</option>
          <option value="created:desc">Newest first</option>
          <option value="created:asc">Oldest first</option>
          <option value="value:desc">Value (high → low)</option>
          <option value="last_contact:desc">Last contact (recent)</option>
          <option value="last_contact:asc">Last contact (dormant)</option>
          <option value="name:asc">Name (A→Z)</option>
        </select>
      </div>

      {canAct && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-forge-lime/30 bg-forge-lime/5 px-4 py-3">
          <span className="text-xs font-bold text-forge-lime">{selected.size} selected</span>
          {canManage && (
            <select disabled={busy} className={sel} defaultValue="" onChange={(e) => { if (e.target.value) void bulk("assign", { userId: e.target.value === "__none" ? null : e.target.value }); e.target.value = ""; }}>
              <option value="" disabled>Assign to…</option>
              <option value="__none">Unassign</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </select>
          )}
          <select disabled={busy} className={sel} defaultValue="" onChange={(e) => { if (e.target.value) void bulk("stage", { stage: e.target.value }); e.target.value = ""; }}>
            <option value="" disabled>Set stage…</option>
            {MANUAL_STAGES.map((s: PipelineStage) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
          {canManage && (
            <select disabled={busy} className={sel} defaultValue="" onChange={(e) => { if (e.target.value) void bulk("add_to_campaign", { campaignId: e.target.value }); e.target.value = ""; }}>
              <option value="" disabled>Add to campaign…</option>
              {campaigns.filter((c) => c.status === "draft" || c.status === "active" || c.status === "paused").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          <button
            disabled={busy}
            onClick={() => { if (window.confirm(`Suppress ${selected.size} contact(s)? This blocks ALL automated outreach and cannot be undone from the dashboard.`)) void bulk("suppress"); }}
            className="rounded-lg border border-forge-rust/50 px-3 py-1.5 text-xs font-bold text-forge-rust hover:bg-forge-rust/10"
          >
            Suppress
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-white/[0.04] text-[10px] uppercase tracking-wider text-white/45">
            <tr>
              {canAct && <th className="p-3"><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>}
              <th className="p-3">Lead</th>
              <th className="p-3">Score</th>
              <th className="p-3">Category</th>
              <th className="p-3">Stage</th>
              <th className="p-3">Project</th>
              <th className="p-3">Value</th>
              <th className="p-3">Source</th>
              <th className="p-3">Assigned</th>
              <th className="p-3">Last contact</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {leads.map((lead) => (
              <tr key={lead.id} className={lead.suppressed ? "opacity-50" : ""}>
                {canAct && <td className="p-3"><input type="checkbox" checked={selected.has(lead.id)} onChange={() => toggle(lead.id)} /></td>}
                <td className="p-3">
                  <Link href={`/dashboard/revenue-rescue/leads/${lead.id}?org=${orgId}`} className="font-semibold hover:text-forge-lime">
                    {[lead.firstName, lead.lastName].filter(Boolean).join(" ") || "Unnamed lead"}
                  </Link>
                  <p className="text-xs text-white/40">{lead.email ?? lead.phone ?? "No contact info"}</p>
                </td>
                <td className="p-3 font-bold text-forge-lime">{lead.score ?? "—"}</td>
                <td className="p-3 text-xs">{lead.category ? CATEGORY_LABELS[lead.category as LeadCategory] ?? lead.category : "—"}{lead.needsReview && <span className="ml-1 text-yellow-300" title="Needs review">•</span>}</td>
                <td className="p-3 text-xs">
                  {lead.suppressed ? <span className="rounded border border-forge-rust/50 px-1.5 py-0.5 text-[10px] font-bold text-forge-rust">SUPPRESSED</span> : STAGE_LABELS[lead.pipelineStage as PipelineStage] ?? lead.pipelineStage}
                </td>
                <td className="p-3 text-xs">{lead.projectType ?? "—"}</td>
                <td className="p-3 text-xs">{lead.estimatedValue != null ? money(lead.estimatedValue) : "—"}</td>
                <td className="p-3 text-xs">{lead.source ?? "—"}</td>
                <td className="p-3 text-xs">{lead.assignedName ?? <span className="text-white/35">Unassigned</span>}</td>
                <td className="p-3 text-xs">{lead.lastContactDate ? lead.lastContactDate.slice(0, 10) : "—"}</td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr><td colSpan={canAct ? 10 : 9} className="p-8 text-center text-sm text-white/45">No leads match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-white/50">
        <span>{total.toLocaleString()} lead{total === 1 ? "" : "s"}</span>
        <div className="flex items-center gap-2">
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40">Previous</button>
          <span>Page {page + 1} of {pages}</span>
          <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40">Next</button>
        </div>
      </div>
    </div>
  );
}
