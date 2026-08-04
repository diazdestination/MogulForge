"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, RefreshCw } from "lucide-react";

/**
 * Settings mirror of the onboarding status screen: live-checked connection
 * statuses (Google, leads/CRM, website, calendar) with connect/disconnect for
 * the org's own Google account. Statuses come from the same live checks as the
 * wizard — never from stored "done" flags.
 */

type StatusShape = {
  googleConfigured: boolean;
  google: { connected: boolean; accountEmail: string | null };
  leads: { activeCrmProviders: string[]; hasCrmConnection: boolean; leadCount: number };
  website: { origins: string[]; websiteUrl: string };
  calendar: { syncProvider: string; orgConnected: boolean; workspaceConnected: boolean; calendlyUrl: string };
};

export function OrgConnectionsCard({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const [status, setStatus] = useState<StatusShape | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/onboarding`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Could not load connection status.");
        return;
      }
      setStatus(body.status);
      setError("");
    } catch {
      setError("Could not load connection status.");
    }
  }, [orgId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function disconnectGoogle() {
    if (!window.confirm("Disconnect this Google account? Appointment sync through it stops immediately.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/calendar/oauth/google_calendar`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Could not disconnect.");
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const returnTo = encodeURIComponent(`/dashboard/revenue-rescue/settings?org=${orgId}`);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[.03] p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold">Connections</p>
          <p className="mt-1 text-xs text-white/45">Live status — nothing shows green unless it&rsquo;s actually connected right now.</p>
        </div>
        <Link href={`/onboarding?revisit=1&org=${orgId}`} className="rounded-full border border-white/15 px-4 py-2 text-xs font-bold text-white/60 transition hover:border-white/40 hover:text-white">
          Open guided setup
        </Link>
      </div>

      {error && <p className="mt-4 rounded-xl border border-forge-rust/50 bg-forge-rust/5 px-4 py-3 text-sm text-forge-rust">{error}</p>}
      {!status && !error && (
        <p className="mt-4 text-sm text-white/45"><RefreshCw className="mr-2 inline h-4 w-4 animate-spin" />Checking connections…</p>
      )}

      {status && (
        <div className="mt-4 grid gap-3">
          <Row
            ok={status.google.connected}
            title="Google account"
            okText={`Connected as ${status.google.accountEmail ?? "your Google account"}`}
            pendingText={status.googleConfigured ? "Not connected" : "Unavailable — Google sign-in isn't configured on the platform yet"}
            action={
              canManage ? (
                status.google.connected ? (
                  <button type="button" onClick={() => void disconnectGoogle()} disabled={busy} className="rounded-full border border-forge-rust/50 px-4 py-1.5 text-xs font-bold text-forge-rust transition hover:bg-forge-rust/10 disabled:opacity-50">
                    Disconnect
                  </button>
                ) : status.googleConfigured ? (
                  <a href={`/api/orgs/${orgId}/calendar/oauth/google_calendar?returnTo=${returnTo}`} className="rounded-full bg-forge-lime px-4 py-1.5 text-xs font-bold text-black transition hover:brightness-110">
                    Connect Google
                  </a>
                ) : null
              ) : null
            }
          />
          <Row
            ok={status.leads.leadCount > 0 || status.leads.activeCrmProviders.length > 0}
            title="Leads & CRM"
            okText={[
              status.leads.leadCount > 0 ? `${status.leads.leadCount} leads` : "",
              status.leads.activeCrmProviders.length > 0 ? `CRM sync active (${status.leads.activeCrmProviders.join(", ")})` : "",
            ].filter(Boolean).join(" · ")}
            pendingText={status.leads.hasCrmConnection ? "CRM connection saved but not active yet" : "No leads or CRM connection yet"}
            action={<Link href={`/dashboard/revenue-rescue/integrations?org=${orgId}`} className="text-xs font-bold text-white/50 underline hover:text-white">Integrations</Link>}
          />
          <Row
            ok={status.website.origins.length > 0}
            title="Website embeds"
            okText={`${status.website.origins.length} approved origin${status.website.origins.length === 1 ? "" : "s"}`}
            pendingText="No approved origins — your site can't embed anything yet"
            action={<Link href={`/dashboard/revenue-rescue/integrations?org=${orgId}`} className="text-xs font-bold text-white/50 underline hover:text-white">Manage</Link>}
          />
          <Row
            ok={status.calendar.syncProvider !== "none" && (status.calendar.orgConnected || status.calendar.workspaceConnected)}
            title="Calendar sync"
            okText={`Bookings sync to ${status.calendar.syncProvider === "outlook_calendar" ? "Outlook" : "Google Calendar"}`}
            pendingText={status.google.connected ? "Google is connected — turn on booking sync in Appointments" : "Not set up"}
            action={<Link href={`/dashboard/revenue-rescue/appointments?org=${orgId}`} className="text-xs font-bold text-white/50 underline hover:text-white">Appointments</Link>}
          />
        </div>
      )}
    </div>
  );
}

function Row({ ok, title, okText, pendingText, action }: { ok: boolean; title: string; okText: string; pendingText: string; action: React.ReactNode }) {
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${ok ? "border-forge-lime/40 bg-forge-lime/5" : "border-amber-400/30 bg-amber-400/5"}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-1 h-2.5 w-2.5 flex-none rounded-full ${ok ? "bg-forge-lime" : "bg-amber-400"}`} />
        <div>
          <p className="text-sm font-bold">{title}</p>
          <p className={`mt-0.5 text-xs ${ok ? "text-forge-lime" : "text-amber-200"}`}>
            {ok && <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />}
            {ok ? okText : pendingText}
          </p>
        </div>
      </div>
      {action}
    </div>
  );
}
