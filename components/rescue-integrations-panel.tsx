"use client";
import { useCallback, useEffect, useState } from "react";
import type { ApiScope } from "@/lib/public-api/scopes";
import { API_SCOPE_DESCRIPTIONS } from "@/lib/public-api/scopes";
import { RescueWebhooksSection } from "@/components/rescue-webhooks-section";
import { RescueCrmSection } from "@/components/rescue-crm-section";
import { embedStyles } from "@/components/embed/embed-branding";
import { DEFAULT_EMBED_THEME, EMBED_THEME_MODES, EMBED_THEME_RADII, normalizeEmbedTheme, type EmbedTheme } from "@/lib/embed/theme-core";

export const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";
export const input = "rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white";
export const btn = "rounded-lg bg-forge-lime px-4 py-2 text-xs font-bold text-black disabled:opacity-50";
export const btnGhost = "rounded-lg border border-white/15 px-4 py-2 text-xs font-bold text-white/70 hover:text-white disabled:opacity-50";

type ApiKeyRecord = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  status: "active" | "revoked";
  lastUsedAt: string | null;
  createdAt: string;
};

const TABS = [
  { id: "keys", label: "API keys" },
  { id: "webhooks", label: "Webhooks" },
  { id: "embed", label: "Embeds" },
  { id: "crm", label: "CRM sync" },
] as const;

export function RescueIntegrationsPanel({ orgId, apiAccessEnabled }: { orgId: string; apiAccessEnabled: boolean }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("keys");
  return (
    <div className="space-y-6">
      {!apiAccessEnabled && (
        <div className={`${box} border-amber-400/30 text-sm text-amber-200`}>
          Public API access is not enabled for this organization yet. You can prepare keys, webhooks, and mappings here, but API requests
          will be rejected until access is enabled on your plan.
        </div>
      )}
      <div className="flex flex-wrap gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-xl px-4 py-2 text-xs font-bold uppercase tracking-wide transition ${
              tab === t.id ? "bg-forge-lime text-black" : "text-white/55 hover:bg-white/10 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "keys" && <ApiKeysSection orgId={orgId} />}
      {tab === "webhooks" && <RescueWebhooksSection orgId={orgId} />}
      {tab === "embed" && <EmbedSection orgId={orgId} />}
      {tab === "crm" && <RescueCrmSection orgId={orgId} />}
    </div>
  );
}

function ApiKeysSection({ orgId }: { orgId: string }) {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [form, setForm] = useState<{ name: string; scopes: ApiScope[] }>({ name: "", scopes: [] });
  const [revealed, setRevealed] = useState<{ name: string; rawKey: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/integrations/api-keys`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not load API keys.");
        return;
      }
      setKeys(body.keys);
      setScopes(body.scopes);
      setError("");
    } catch {
      setError("Could not load API keys.");
    }
  }, [orgId]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/integrations/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not create the key.");
        return;
      }
      setRevealed({ name: body.key.name, rawKey: body.rawKey });
      setForm({ name: "", scopes: [] });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function rotate(keyId: string) {
    if (!confirm("Rotate this key? The current key stops working immediately and a replacement is issued.")) return;
    const res = await fetch(`/api/orgs/${orgId}/integrations/api-keys/${keyId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "rotate" }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setError(body?.error ?? "Rotation failed.");
      return;
    }
    setRevealed({ name: body.key.name, rawKey: body.rawKey });
    await load();
  }

  async function revoke(keyId: string) {
    if (!confirm("Revoke this key? Requests using it will fail immediately. This cannot be undone.")) return;
    const res = await fetch(`/api/orgs/${orgId}/integrations/api-keys/${keyId}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Revoke failed.");
      return;
    }
    await load();
  }

  return (
    <div className="space-y-6">
      {revealed && (
        <div className={`${box} border-forge-lime/40`}>
          <p className="text-sm font-bold">“{revealed.name}” — copy your key now</p>
          <p className="mt-1 text-xs text-white/50">This is the only time the full key is shown. We store only a hash.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <code className="break-all rounded-lg bg-black/50 px-3 py-2 font-mono text-xs text-forge-lime">{revealed.rawKey}</code>
            <button className={btnGhost} onClick={() => navigator.clipboard?.writeText(revealed.rawKey).catch(() => {})}>
              Copy
            </button>
            <button className={btnGhost} onClick={() => setRevealed(null)}>
              I saved it
            </button>
          </div>
        </div>
      )}

      <form onSubmit={createKey} className={box}>
        <p className="text-sm font-bold">Create an API key</p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Key name
            <input
              className={input}
              required
              maxLength={100}
              placeholder="e.g. Website integration"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <button className={btn} disabled={busy || form.scopes.length === 0}>
            {busy ? "Creating…" : "Create key"}
          </button>
        </div>
        <p className="mt-4 text-xs font-bold uppercase tracking-wider text-white/40">Scopes</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {scopes.map((scope) => (
            <label key={scope} className="flex items-center gap-2 text-xs text-white/70">
              <input
                type="checkbox"
                checked={form.scopes.includes(scope)}
                onChange={(e) =>
                  setForm({ ...form, scopes: e.target.checked ? [...form.scopes, scope] : form.scopes.filter((s) => s !== scope) })
                }
              />
              <span>
                <code className="text-forge-lime/90">{scope}</code> — {API_SCOPE_DESCRIPTIONS[scope]}
              </span>
            </label>
          ))}
        </div>
      </form>

      {error && <p className="text-sm text-red-300">{error}</p>}

      <div className={box}>
        <p className="text-sm font-bold">Keys</p>
        {keys.length === 0 ? (
          <p className="mt-3 text-sm text-white/50">No API keys yet. Create one above to call the public API.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-white/40">
                <tr>
                  <th className="py-2 pr-4">Name</th>
                  <th className="py-2 pr-4">Key</th>
                  <th className="py-2 pr-4">Scopes</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Last used</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {keys.map((key) => (
                  <tr key={key.id}>
                    <td className="py-2 pr-4 font-bold">{key.name}</td>
                    <td className="py-2 pr-4 font-mono text-white/60">{key.prefix}…</td>
                    <td className="max-w-[240px] py-2 pr-4 text-white/60">{key.scopes.join(", ")}</td>
                    <td className="py-2 pr-4">
                      <span className={key.status === "active" ? "text-forge-lime" : "text-red-300"}>{key.status}</span>
                    </td>
                    <td className="py-2 pr-4 text-white/50">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}</td>
                    <td className="py-2 text-right">
                      {key.status === "active" && (
                        <span className="flex justify-end gap-2">
                          <button className={btnGhost} onClick={() => rotate(key.id)}>
                            Rotate
                          </button>
                          <button className={btnGhost} onClick={() => revoke(key.id)}>
                            Revoke
                          </button>
                        </span>
                      )}
                    </td>
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

function EmbedSection({ orgId }: { orgId: string }) {
  const [origins, setOrigins] = useState("");
  const [saved, setSaved] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const appOrigin = typeof window !== "undefined" ? window.location.origin : "";

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/integrations/origins`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not load origins.");
        return;
      }
      setSaved(body.allowedOrigins);
      setOrigins(body.allowedOrigins.join("\n"));
      setError("");
    } catch {
      setError("Could not load origins.");
    }
  }, [orgId]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/integrations/origins`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowedOrigins: origins.split("\n").map((s) => s.trim()).filter(Boolean) }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not save origins.");
        return;
      }
      setSaved(body.allowedOrigins);
      setOrigins(body.allowedOrigins.join("\n"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className={box}>
        <p className="text-sm font-bold">Approved embed origins</p>
        <p className="mt-1 text-xs text-white/50">
          Embed tokens are only issued for these origins, and the embedded pages refuse to render anywhere else (enforced by CSP
          frame-ancestors). One origin per line — e.g. <code>https://www.yourclientsite.com</code> or <code>*.yourclientsite.com</code>.
        </p>
        <textarea
          className={`${input} mt-3 w-full font-mono`}
          rows={4}
          value={origins}
          onChange={(e) => setOrigins(e.target.value)}
          placeholder="https://www.example.com"
        />
        <div className="mt-3 flex items-center gap-3">
          <button className={btn} onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save origins"}
          </button>
          <span className="text-xs text-white/40">{saved.length} approved</span>
        </div>
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      </div>

      <EmbedThemeEditor orgId={orgId} />

      <div className={box}>
        <p className="text-sm font-bold">How embedding works</p>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-white/60">
          <li>
            Create an API key with the <code className="text-forge-lime/90">embed:write</code> scope (API keys tab).
          </li>
          <li>
            From your server (never the browser), request a short-lived embed token:
            <pre className="mt-2 overflow-x-auto rounded-lg bg-black/50 p-3 font-mono text-xs text-white/70">{`POST ${appOrigin}/api/v1/embed/sessions
Authorization: Bearer rrk_...
{ "origin": "https://www.yourclientsite.com", "modules": ["dashboard"], "role": "viewer" }`}</pre>
          </li>
          <li>
            Load the module on your page with the loader script:
            <pre className="mt-2 overflow-x-auto rounded-lg bg-black/50 p-3 font-mono text-xs text-white/70">{`<script src="${appOrigin}/embed/v1/loader.js" async></script>
<div data-rr-embed="dashboard" data-rr-token="TOKEN_FROM_YOUR_SERVER"></div>`}</pre>
          </li>
        </ol>
        <p className="mt-3 text-xs text-white/50">
          Full instructions for React, plain JavaScript, iframe, and server-rendered sites are on the{" "}
          <a className="text-forge-lime underline" href="/revenue-rescue/developers" target="_blank">
            developer documentation page
          </a>
          .
        </p>
      </div>
    </div>
  );
}

/** Org-default embed theme editor with a live widget preview. */
function EmbedThemeEditor({ orgId }: { orgId: string }) {
  const [theme, setTheme] = useState<EmbedTheme>(DEFAULT_EMBED_THEME);
  const [status, setStatus] = useState<"loading" | "ready" | "saving">("loading");
  const [error, setError] = useState("");
  const [savedAt, setSavedAt] = useState(0);
  const [previewModule, setPreviewModule] = useState<"widget" | "dashboard">("widget");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/orgs/${orgId}/integrations/embed-theme`, { cache: "no-store" })
      .then((res) => res.json().then((body) => ({ ok: res.ok, body })))
      .then(({ ok, body }) => {
        if (cancelled) return;
        if (ok) setTheme(normalizeEmbedTheme(body.theme));
        else setError(body?.error ?? "Could not load the embed theme.");
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not load the embed theme.");
          setStatus("ready");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  async function save() {
    setStatus("saving");
    setError("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/integrations/embed-theme`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not save the theme.");
        return;
      }
      setTheme(normalizeEmbedTheme(body.theme));
      setSavedAt((n) => n + 1);
    } finally {
      setStatus("ready");
    }
  }

  const set = (patch: Partial<EmbedTheme>) => setTheme((t) => ({ ...t, ...patch }));
  const preview = embedStyles(theme, null);

  return (
    <div className={box}>
      <p className="text-sm font-bold">Widget & dashboard theme</p>
      <p className="mt-1 text-xs text-white/50">
        Default look for your embedded modules on client sites — light or dark, accent color, corner radius, and an optional logo. Each
        mount can still override these via loader options (see the docs below).
      </p>
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Mode
              <select className={input} value={theme.mode} onChange={(e) => set({ mode: e.target.value as EmbedTheme["mode"] })}>
                {EMBED_THEME_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Corner radius
              <select className={input} value={theme.radius} onChange={(e) => set({ radius: e.target.value as EmbedTheme["radius"] })}>
                {EMBED_THEME_RADII.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Accent color
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Accent color picker"
                  className="h-9 w-10 cursor-pointer rounded border border-white/15 bg-black/40"
                  value={theme.accentColor ?? "#c8f31d"}
                  onChange={(e) => set({ accentColor: e.target.value })}
                />
                <input
                  className={`${input} w-28 font-mono`}
                  placeholder="inherit"
                  value={theme.accentColor ?? ""}
                  onChange={(e) => set({ accentColor: e.target.value || null })}
                />
              </span>
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Background color
              <span className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Background color picker"
                  className="h-9 w-10 cursor-pointer rounded border border-white/15 bg-black/40"
                  value={theme.backgroundColor ?? (theme.mode === "dark" ? "#0b0e11" : "#ffffff")}
                  onChange={(e) => set({ backgroundColor: e.target.value })}
                />
                <input
                  className={`${input} w-28 font-mono`}
                  placeholder="default"
                  value={theme.backgroundColor ?? ""}
                  onChange={(e) => set({ backgroundColor: e.target.value || null })}
                />
              </span>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Logo URL (optional, https)
            <input
              className={`${input} w-full`}
              placeholder="https://www.yoursite.com/logo.svg"
              value={theme.logoUrl ?? ""}
              onChange={(e) => set({ logoUrl: e.target.value || null })}
            />
          </label>
          <div className="flex items-center gap-3">
            <button className={btn} onClick={save} disabled={status !== "ready"}>
              {status === "saving" ? "Saving…" : "Save theme"}
            </button>
            <button className={btnGhost} onClick={() => setTheme(DEFAULT_EMBED_THEME)} disabled={status !== "ready"}>
              Reset to defaults
            </button>
            {savedAt > 0 && status === "ready" && !error && <span className="text-xs text-forge-lime">Saved.</span>}
          </div>
          {error && <p className="text-sm text-red-300">{error}</p>}
          <p className="text-[11px] text-white/40">
            Colors must be hex values; logos must be https URLs. Invalid values are dropped — embeds never accept arbitrary CSS.
          </p>
        </div>

        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-bold uppercase tracking-wider text-white/40">
              Live preview — {previewModule === "widget" ? "lead widget" : "dashboard"}
            </p>
            <div className="flex gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
              {(["widget", "dashboard"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPreviewModule(m)}
                  className={`rounded-md px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide transition ${
                    previewModule === m ? "bg-forge-lime text-black" : "text-white/55 hover:text-white"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2 overflow-hidden rounded-xl border border-white/10">
            {previewModule === "widget" ? (
              <div className="space-y-3 p-5" style={preview.root}>
                <div className="flex items-center gap-2.5">
                  {theme.logoUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- client-provided preview logo
                    <img src={theme.logoUrl} alt="" className="h-6 w-auto" />
                  )}
                  <p className="text-sm font-bold">Request a free estimate</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="px-3 py-2 text-sm" style={preview.input}><span style={preview.faint}>First name</span></div>
                  <div className="px-3 py-2 text-sm" style={preview.input}><span style={preview.faint}>Last name</span></div>
                </div>
                <div className="px-3 py-2 text-sm" style={preview.input}><span style={preview.faint}>Email</span></div>
                <div className="w-full px-4 py-2.5 text-center text-sm font-bold" style={preview.accentSolid}>Get my estimate</div>
                <p className="text-center text-[10px] uppercase tracking-wider" style={preview.faint}>Powered by MogulForge Revenue Rescue</p>
              </div>
            ) : (
              <div className="space-y-3 p-5" style={preview.root}>
                <div className="flex items-center gap-2.5">
                  {theme.logoUrl && (
                    // eslint-disable-next-line @next/next/no-img-element -- client-provided preview logo
                    <img src={theme.logoUrl} alt="" className="h-6 w-auto" />
                  )}
                  <p className="text-sm font-bold">Revenue dashboard</p>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Leads", value: "128" },
                    { label: "Booked", value: "42" },
                    { label: "Revenue", value: "$18.4k" },
                  ].map((m) => (
                    <div key={m.label} className="p-3" style={preview.card}>
                      <p className="text-[10px] uppercase tracking-wider" style={preview.faint}>{m.label}</p>
                      <p className="mt-1 text-lg font-bold" style={preview.heading}>{m.value}</p>
                    </div>
                  ))}
                </div>
                <div className="p-3" style={preview.card}>
                  <p className="text-[10px] uppercase tracking-wider" style={preview.faint}>Lead funnel</p>
                  <div className="mt-2 space-y-2">
                    {[
                      { label: "New", pct: 100 },
                      { label: "Contacted", pct: 64 },
                      { label: "Booked", pct: 33 },
                    ].map((row) => (
                      <div key={row.label} className="flex items-center gap-2">
                        <span className="w-20 text-xs" style={preview.muted}>{row.label}</span>
                        <div className="h-2.5 flex-1 overflow-hidden" style={preview.accentSoft}>
                          <div className="h-full" style={{ ...preview.accentSolid, width: `${row.pct}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="text-center text-[10px] uppercase tracking-wider" style={preview.faint}>Powered by MogulForge Revenue Rescue</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
