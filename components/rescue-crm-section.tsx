"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { box, btn, btnGhost, input } from "@/components/rescue-integrations-panel";
import {
  applyFieldMapping,
  LEAD_FIELDS,
  MAPPING_TRANSFORMS,
  SAMPLE_LEAD,
  TRANSFORM_LABELS,
  type FieldMappingEntry,
} from "@/lib/crm/mapping";

type Provider = { id: string; label: string; status: "available" | "in_development" | "coming_soon"; description: string };
type Connection = {
  id: string;
  provider: string;
  name: string;
  status: "draft" | "testing" | "active" | "disabled" | "error";
  syncDirection: "outbound" | "inbound" | "bidirectional";
  config: Record<string, unknown>;
  fieldMapping: FieldMappingEntry[];
  lastTestAt: string | null;
  lastTestResult: { ok?: boolean; statusCode?: number | null; message?: string } | null;
};
type Conflict = {
  id: string;
  leadId: string;
  leadName: string | null;
  source: string;
  fields: Array<{ field: string; localValue: unknown; remoteValue: unknown }>;
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  createdAt: string;
};

const STATUS_BADGE: Record<Provider["status"], { label: string; cls: string }> = {
  available: { label: "Available", cls: "border-forge-lime/40 text-forge-lime" },
  in_development: { label: "In development", cls: "border-amber-400/40 text-amber-300" },
  coming_soon: { label: "Coming soon", cls: "border-white/20 text-white/50" },
};

export function RescueCrmSection({ orgId }: { orgId: string }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [createForm, setCreateForm] = useState<{ provider: string; name: string; url: string; authHeaderName: string; authHeaderValue: string } | null>(null);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [mappingDraft, setMappingDraft] = useState<FieldMappingEntry[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/integrations/crm`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not load CRM integrations.");
        return;
      }
      setProviders(body.providers);
      setConnections(body.connections);
      setConflicts(body.conflicts);
      setError("");
      setEditing((prev) => (prev ? (body.connections as Connection[]).find((c) => c.id === prev.id) ?? null : null));
    } catch {
      setError("Could not load CRM integrations.");
    }
  }, [orgId]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const preview = useMemo(() => {
    try {
      return JSON.stringify(applyFieldMapping(mappingDraft, SAMPLE_LEAD), null, 2);
    } catch {
      return "{}";
    }
  }, [mappingDraft]);

  async function call(url: string, bodyJson?: unknown, method = "POST") {
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch(url, {
        method,
        ...(bodyJson !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(bodyJson) } : {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Request failed.");
        return null;
      }
      setError("");
      await load();
      return body;
    } finally {
      setBusy(false);
    }
  }

  function startEdit(conn: Connection) {
    setEditing(conn);
    setMappingDraft(conn.fieldMapping.length > 0 ? conn.fieldMapping : [
      { source: "firstName", target: "first_name", transform: "none" },
      { source: "lastName", target: "last_name", transform: "none" },
      { source: "email", target: "email", transform: "lowercase" },
      { source: "phone", target: "phone", transform: "e164_us" },
    ]);
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-300">{error}</p>}
      {notice && <p className="text-sm text-forge-lime">{notice}</p>}

      <div className={box}>
        <p className="text-sm font-bold">CRM providers</p>
        <p className="mt-1 text-xs text-white/50">
          Only providers marked “Available” can be connected today — the rest are honest placeholders, not fake connections.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {providers.map((p) => (
            <div key={p.id} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold">{p.label}</p>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_BADGE[p.status].cls}`}>
                  {STATUS_BADGE[p.status].label}
                </span>
              </div>
              <p className="mt-2 text-xs text-white/50">{p.description}</p>
              {p.status === "available" && (
                <button
                  className={`${btnGhost} mt-3`}
                  onClick={() => setCreateForm({ provider: p.id, name: "", url: "", authHeaderName: "", authHeaderValue: "" })}
                >
                  Connect
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {createForm && (
        <form
          className={box}
          onSubmit={async (e) => {
            e.preventDefault();
            const created = await call(`/api/orgs/${orgId}/integrations/crm`, {
              provider: createForm.provider,
              name: createForm.name,
              config: {
                url: createForm.url,
                authHeaderName: createForm.authHeaderName || undefined,
                authHeaderValue: createForm.authHeaderValue || undefined,
              },
            });
            if (created) setCreateForm(null);
          }}
        >
          <p className="text-sm font-bold">New {createForm.provider === "zapier" ? "Zapier / Make / n8n" : "generic webhook"} connection</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Connection name
              <input className={input} required maxLength={100} value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Destination URL (POST)
              <input className={input} required placeholder="https://hooks.zapier.com/…" value={createForm.url} onChange={(e) => setCreateForm({ ...createForm, url: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Auth header name (optional)
              <input className={input} placeholder="Authorization" value={createForm.authHeaderName} onChange={(e) => setCreateForm({ ...createForm, authHeaderName: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Auth header value (optional)
              <input className={input} placeholder="Bearer …" value={createForm.authHeaderValue} onChange={(e) => setCreateForm({ ...createForm, authHeaderValue: e.target.value })} />
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <button className={btn} disabled={busy}>
              Create connection
            </button>
            <button type="button" className={btnGhost} onClick={() => setCreateForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {connections.length > 0 && (
        <div className={box}>
          <p className="text-sm font-bold">Connections</p>
          <div className="mt-3 space-y-2">
            {connections.map((conn) => (
              <div key={conn.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 p-3 text-xs">
                <div>
                  <span className="font-bold">{conn.name}</span> <span className="text-white/40">({conn.provider})</span>{" "}
                  <span className={conn.status === "active" ? "text-forge-lime" : conn.status === "error" ? "text-red-300" : "text-white/60"}>· {conn.status}</span>
                  {conn.lastTestResult && (
                    <span className="text-white/40">
                      {" "}
                      · last test: {conn.lastTestResult.ok ? "passed" : `failed (${conn.lastTestResult.message ?? "error"})`}
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button className={btnGhost} onClick={() => startEdit(conn)}>
                    Configure
                  </button>
                  <button
                    className={btnGhost}
                    disabled={busy}
                    onClick={() => {
                      if (confirm("Delete this connection?")) void call(`/api/orgs/${orgId}/integrations/crm/${conn.id}`, undefined, "DELETE");
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <div className={box}>
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold">Field mapping — {editing.name}</p>
            <button className={btnGhost} onClick={() => setEditing(null)}>
              Close
            </button>
          </div>
          <p className="mt-1 text-xs text-white/50">
            Choose which lead fields are sent, how they are transformed, and what the target field is called in your system.
          </p>
          <div className="mt-4 space-y-2">
            {mappingDraft.map((row, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                <select
                  className={input}
                  value={row.source}
                  onChange={(e) => setMappingDraft(mappingDraft.map((r, j) => (j === i ? { ...r, source: e.target.value as FieldMappingEntry["source"] } : r)))}
                >
                  {LEAD_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <span className="text-white/40">→</span>
                <select
                  className={input}
                  value={row.transform}
                  onChange={(e) => setMappingDraft(mappingDraft.map((r, j) => (j === i ? { ...r, transform: e.target.value as FieldMappingEntry["transform"] } : r)))}
                >
                  {MAPPING_TRANSFORMS.map((t) => (
                    <option key={t} value={t}>
                      {TRANSFORM_LABELS[t]}
                    </option>
                  ))}
                </select>
                <span className="text-white/40">→</span>
                <input
                  className={input}
                  placeholder="target_field"
                  value={row.target}
                  onChange={(e) => setMappingDraft(mappingDraft.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)))}
                />
                <button className={btnGhost} onClick={() => setMappingDraft(mappingDraft.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
            <button className={btnGhost} onClick={() => setMappingDraft([...mappingDraft, { source: "notes", target: "", transform: "none" }])}>
              + Add field
            </button>
          </div>

          <p className="mt-4 text-xs font-bold uppercase tracking-wider text-white/40">Preview (sample lead)</p>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-black/50 p-3 font-mono text-xs text-white/70">{preview}</pre>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className={btn}
              disabled={busy}
              onClick={async () => {
                const saved = await call(`/api/orgs/${orgId}/integrations/crm/${editing.id}`, { fieldMapping: mappingDraft }, "PATCH");
                if (saved) setNotice("Mapping saved.");
              }}
            >
              Save mapping
            </button>
            <button
              className={btnGhost}
              disabled={busy}
              onClick={async () => {
                const body = await call(`/api/orgs/${orgId}/integrations/crm/${editing.id}/test`);
                if (body?.result) setNotice(body.result.ok ? `Test passed (HTTP ${body.result.statusCode}).` : `Test failed: ${body.result.message}`);
              }}
            >
              Send test payload
            </button>
            {editing.status !== "active" ? (
              <button
                className={btnGhost}
                disabled={busy || !(editing.lastTestResult && editing.lastTestResult.ok === true)}
                title={editing.lastTestResult?.ok ? "" : "Run a successful test first"}
                onClick={async () => {
                  const body = await call(`/api/orgs/${orgId}/integrations/crm/${editing.id}`, { status: "active" }, "PATCH");
                  if (body) setNotice("Connection activated.");
                }}
              >
                Activate
              </button>
            ) : (
              <button className={btnGhost} disabled={busy} onClick={() => call(`/api/orgs/${orgId}/integrations/crm/${editing.id}`, { status: "disabled" }, "PATCH")}>
                Disable
              </button>
            )}
          </div>
          {!editing.lastTestResult?.ok && <p className="mt-2 text-xs text-white/40">Connections can only be activated after a successful test — test-before-activate is enforced.</p>}
        </div>
      )}

      <div className={box}>
        <p className="text-sm font-bold">Sync conflicts {conflicts.length > 0 && <span className="text-amber-300">({conflicts.length} pending)</span>}</p>
        <p className="mt-1 text-xs text-white/50">
          When an external update conflicts with newer local data, nothing is overwritten — the conflict lands here for a human decision.
        </p>
        {conflicts.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">No pending conflicts.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {conflicts.map((conflict) => (
              <div key={conflict.id} className="rounded-xl border border-amber-400/20 bg-black/20 p-4 text-xs">
                <p className="font-bold">
                  {conflict.leadName ?? conflict.leadId} <span className="font-normal text-white/40">via {conflict.source} · {new Date(conflict.createdAt).toLocaleString()}</span>
                </p>
                <table className="mt-2 w-full text-left">
                  <thead className="text-white/40">
                    <tr>
                      <th className="py-1 pr-4">Field</th>
                      <th className="py-1 pr-4">Current (local)</th>
                      <th className="py-1">Incoming (remote)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {conflict.fields.map((f) => (
                      <tr key={f.field}>
                        <td className="py-1 pr-4 font-mono">{f.field}</td>
                        <td className="py-1 pr-4 text-white/60">{String(f.localValue ?? "—")}</td>
                        <td className="py-1 text-amber-200">{String(f.remoteValue ?? "—")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex gap-2">
                  <button className={btnGhost} disabled={busy} onClick={() => call(`/api/orgs/${orgId}/integrations/crm/conflicts/${conflict.id}`, { resolution: "apply_remote" })}>
                    Apply incoming
                  </button>
                  <button className={btnGhost} disabled={busy} onClick={() => call(`/api/orgs/${orgId}/integrations/crm/conflicts/${conflict.id}`, { resolution: "keep_local" })}>
                    Keep ours
                  </button>
                  <button className={btnGhost} disabled={busy} onClick={() => call(`/api/orgs/${orgId}/integrations/crm/conflicts/${conflict.id}`, { resolution: "dismiss" })}>
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
