"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { APPOINTMENT_STATUSES, APPOINTMENT_STATUS_LABELS, APPOINTMENT_TYPES, type AppointmentStatus } from "@/lib/rescue-engage/calendar-adapters";

type Appointment = {
  id: string; leadId: string; leadFirstName: string | null; leadLastName: string | null;
  appointmentType: string; provider: string;
  scheduledStart: string; scheduledEnd: string | null; address: string | null; notes: string | null;
  status: AppointmentStatus; assignedName: string | null; createdAt: string;
};

type Adapter = { id: string; label: string; connected: boolean; detail: string };

type OrgAccount = { connected: boolean; accountEmail: string | null };

type CalendarInfo = {
  syncProvider: "none" | "google_calendar" | "outlook_calendar";
  calendlyUrl: string;
  bookingUrl: string;
  connections: { google: boolean; outlook: boolean; calendly: boolean };
  orgAccounts: {
    google: OrgAccount;
    outlook: OrgAccount;
    oauthConfigured: { google: boolean; outlook: boolean };
    workspaceFallback: { google: boolean; outlook: boolean };
  };
  canConfigure: boolean;
};

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const input = "rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white";

export function RescueAppointmentsPanel({ orgId, canWrite }: { orgId: string; canWrite: boolean }) {
  const searchParams = useSearchParams();
  const orgSuffix = searchParams.get("org") ? `?org=${searchParams.get("org")}` : "";
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [adapters, setAdapters] = useState<Adapter[]>([]);
  const [calendar, setCalendar] = useState<CalendarInfo | null>(null);
  const [calForm, setCalForm] = useState({ syncProvider: "none", calendlyUrl: "" });
  const [copied, setCopied] = useState(false);
  const [calSaved, setCalSaved] = useState(false);
  const [leadOptions, setLeadOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [scoped, setScoped] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ leadId: "", appointmentType: "estimate", scheduledStart: "", address: "", notes: "" });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/appointments`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not load appointments."); return; }
      setAppointments(body.appointments);
      setAdapters(body.adapters);
      if (body.calendar) {
        setCalendar(body.calendar);
        setCalForm({ syncProvider: body.calendar.syncProvider, calendlyUrl: body.calendar.calendlyUrl });
      }
      setScoped(body.scopedToAssigned === true);
      setError("");
    } catch { setError("Could not load appointments."); }
  }, [orgId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  useEffect(() => {
    if (!canWrite) return;
    // Lightweight lead picker for the manual booking form.
    fetch(`/api/orgs/${orgId}/leads?limit=100&sort=score&dir=desc`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!body) return;
        setLeadOptions(body.leads
          .filter((l: { suppressed: boolean }) => !l.suppressed)
          .map((l: { id: string; firstName: string | null; lastName: string | null; email: string | null }) => ({
            id: l.id,
            name: [l.firstName, l.lastName].filter(Boolean).join(" ") || l.email || "Unnamed lead",
          })));
      })
      .catch(() => {});
  }, [orgId, canWrite]);

  async function book(e: React.FormEvent) {
    e.preventDefault();
    if (!form.leadId || !form.scheduledStart) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/appointments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, scheduledStart: new Date(form.scheduledStart).toISOString() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "Could not book the appointment."); return; }
      setError("");
      setForm({ leadId: "", appointmentType: "estimate", scheduledStart: "", address: "", notes: "" });
      await load();
    } finally { setBusy(false); }
  }

  async function setStatus(id: string, status: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/appointments/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
      });
      if (!res.ok) setError((await res.json().catch(() => null))?.error ?? "Update failed.");
      else { setError(""); await load(); }
    } finally { setBusy(false); }
  }

  async function saveCalendarSettings(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCalSaved(false);
    try {
      const res = await fetch(`/api/orgs/${orgId}/settings`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendar: calForm }),
      });
      if (!res.ok) setError((await res.json().catch(() => null))?.error ?? "Could not save calendar settings.");
      else { setError(""); setCalSaved(true); await load(); }
    } finally { setBusy(false); }
  }

  async function disconnectAccount(provider: "google_calendar" | "outlook_calendar") {
    const label = provider === "google_calendar" ? "Google Calendar" : "Outlook";
    if (!window.confirm(`Disconnect ${label}? Stored tokens are deleted and bookings stop syncing to that account.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orgs/${orgId}/calendar/oauth/${provider}`, { method: "DELETE" });
      if (!res.ok) setError((await res.json().catch(() => null))?.error ?? "Could not disconnect the calendar.");
      else { setError(""); await load(); }
    } finally { setBusy(false); }
  }

  async function copyBookingLink() {
    if (!calendar?.bookingUrl) return;
    try {
      await navigator.clipboard.writeText(calendar.bookingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }

  const upcoming = appointments.filter((a) => a.status === "requested" || a.status === "confirmed" || a.status === "rescheduled");
  const past = appointments.filter((a) => !upcoming.includes(a));

  return (
    <div className="space-y-6">
      {scoped && <p className="text-xs text-white/45">Showing appointments for your assigned leads only.</p>}
      {searchParams.get("calendar") === "connected" && (
        <p className="rounded-xl border border-forge-lime/40 bg-forge-lime/10 px-4 py-3 text-sm text-forge-lime">Calendar account connected. New bookings will sync to it.</p>
      )}
      {searchParams.get("calendar") === "error" && (
        <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">
          Calendar connection failed{searchParams.get("reason") ? ` (${searchParams.get("reason")})` : ""}. Please try again.
        </p>
      )}
      {error && <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">{error}</p>}

      <div className={box}>
        <h2 className="font-display text-xl font-semibold">Calendar providers</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {adapters.map((a) => (
            <div key={a.id} className="rounded-xl bg-black/30 p-3">
              <p className="text-sm font-semibold">{a.label}</p>
              <p className={`mt-1 text-[10px] font-bold uppercase tracking-wider ${a.connected ? "text-forge-lime" : "text-white/40"}`}>
                {a.connected ? "Available" : "Not connected"}
              </p>
              <p className="mt-1 text-xs text-white/45">{a.detail}</p>
            </div>
          ))}
        </div>
      </div>

      {calendar && (
        <div className={box}>
          <h2 className="font-display text-xl font-semibold">Booking link &amp; calendar sync</h2>
          {calendar.bookingUrl ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <code className="max-w-full overflow-x-auto rounded-lg bg-black/40 px-3 py-2 text-xs text-white/70">{calendar.bookingUrl}</code>
              <button type="button" onClick={() => void copyBookingLink()} className="btn-primary px-3 py-1.5 text-xs">
                {copied ? "Copied!" : "Copy link"}
              </button>
              <p className="w-full text-xs text-white/45">Drop this link into campaign messages — bookings made there land in this list automatically.</p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-white/50">Booking link unavailable.</p>
          )}
          {calendar.canConfigure && calendar.orgAccounts && (
            <div className="mt-5 border-t border-white/10 pt-4">
              <h3 className="text-sm font-semibold">Your calendar accounts</h3>
              <p className="mt-1 text-xs text-white/45">Connect this organization&apos;s own Google or Outlook account so bookings land on your calendar.</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {(["google", "outlook"] as const).map((key) => {
                  const provider = key === "google" ? "google_calendar" : "outlook_calendar";
                  const label = key === "google" ? "Google Calendar" : "Outlook Calendar";
                  const account = calendar.orgAccounts[key];
                  const configured = calendar.orgAccounts.oauthConfigured[key];
                  const fallback = calendar.orgAccounts.workspaceFallback[key];
                  const returnTo = typeof window === "undefined" ? "" : `${window.location.pathname}${window.location.search}`;
                  return (
                    <div key={key} className="rounded-xl bg-black/30 p-3">
                      <p className="text-sm font-semibold">{label}</p>
                      {account.connected ? (
                        <>
                          <p className="mt-1 text-xs text-forge-lime">Connected{account.accountEmail ? ` as ${account.accountEmail}` : ""}</p>
                          <button type="button" disabled={busy} onClick={() => void disconnectAccount(provider)} className="mt-2 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/70 hover:border-forge-rust hover:text-forge-rust disabled:opacity-40">
                            Disconnect
                          </button>
                        </>
                      ) : configured ? (
                        <>
                          <p className="mt-1 text-xs text-white/45">{fallback ? "Using the shared workspace account until you connect your own." : "Not connected."}</p>
                          <a href={`/api/orgs/${orgId}/calendar/oauth/${provider}?returnTo=${encodeURIComponent(returnTo)}`} className="btn-primary mt-2 inline-block px-3 py-1.5 text-xs">
                            Connect {key === "google" ? "Google" : "Outlook"}
                          </a>
                        </>
                      ) : (
                        <p className="mt-1 text-xs text-white/45">
                          {fallback
                            ? "Syncing via the shared workspace account. Per-org sign-in is not configured on this server."
                            : "Per-org sign-in is not configured on this server — ask your MogulForge admin to enable it."}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {calendar.canConfigure && (
            <form onSubmit={saveCalendarSettings} className="mt-5 flex flex-wrap items-end gap-3 border-t border-white/10 pt-4">
              <label className="block text-xs text-white/55">Push bookings to
                <select value={calForm.syncProvider} onChange={(e) => setCalForm({ ...calForm, syncProvider: e.target.value })} className={`${input} mt-1 block`}>
                  <option value="none">No calendar push</option>
                  <option value="google_calendar" disabled={!calendar.connections.google}>
                    Google Calendar{calendar.connections.google ? "" : " (not authorized)"}
                  </option>
                  <option value="outlook_calendar" disabled={!calendar.connections.outlook}>
                    Outlook Calendar{calendar.connections.outlook ? "" : " (not authorized)"}
                  </option>
                </select>
              </label>
              <label className="block flex-1 text-xs text-white/55">Calendly scheduling link
                <input value={calForm.calendlyUrl} onChange={(e) => setCalForm({ ...calForm, calendlyUrl: e.target.value })} placeholder="https://calendly.com/your-team/estimate" className={`${input} mt-1 block w-full`} />
              </label>
              <button type="submit" disabled={busy} className="btn-primary px-4 py-2 text-xs disabled:opacity-40">Save</button>
              {calSaved && <span className="text-xs text-forge-lime">Saved</span>}
            </form>
          )}
        </div>
      )}

      {canWrite && (
        <form onSubmit={book} className={`${box} flex flex-wrap items-end gap-3`}>
          <label className="block text-xs text-white/55">Lead
            <select value={form.leadId} onChange={(e) => setForm({ ...form, leadId: e.target.value })} className={`${input} mt-1 block w-52`} required>
              <option value="">Choose a lead…</option>
              {leadOptions.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label className="block text-xs text-white/55">Type
            <select value={form.appointmentType} onChange={(e) => setForm({ ...form, appointmentType: e.target.value })} className={`${input} mt-1 block`}>
              {APPOINTMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
            </select>
          </label>
          <label className="block text-xs text-white/55">When
            <input type="datetime-local" value={form.scheduledStart} onChange={(e) => setForm({ ...form, scheduledStart: e.target.value })} className={`${input} mt-1 block`} required />
          </label>
          <label className="block text-xs text-white/55">Address
            <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Optional" className={`${input} mt-1 block w-48`} />
          </label>
          <label className="block flex-1 text-xs text-white/55">Notes
            <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" className={`${input} mt-1 block w-full`} />
          </label>
          <button type="submit" disabled={busy || !form.leadId || !form.scheduledStart} className="btn-primary px-4 py-2 text-xs disabled:opacity-40">Book manually</button>
        </form>
      )}

      {[{ title: "Upcoming", rows: upcoming }, { title: "Past & closed", rows: past }].map((group) => (
        <div key={group.title} className={box}>
          <h2 className="font-display text-xl font-semibold">{group.title}</h2>
          {group.rows.length === 0 ? (
            <p className="mt-3 text-sm text-white/50">No appointments here yet.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-[10px] uppercase tracking-wider text-white/40">
                  <tr><th className="pb-2">Lead</th><th className="pb-2">Type</th><th className="pb-2">When</th><th className="pb-2">Where</th><th className="pb-2">Assigned</th><th className="pb-2">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {group.rows.map((a) => (
                    <tr key={a.id}>
                      <td className="py-2.5 pr-3">
                        <Link href={`/dashboard/revenue-rescue/leads/${a.leadId}${orgSuffix}`} className="font-semibold hover:text-forge-lime">{[a.leadFirstName, a.leadLastName].filter(Boolean).join(" ") || "Unnamed lead"}</Link>
                      </td>
                      <td className="py-2.5 pr-3 text-xs capitalize">{a.appointmentType.replace("_", " ")}</td>
                      <td className="py-2.5 pr-3 text-xs">{new Date(a.scheduledStart).toLocaleString()}</td>
                      <td className="py-2.5 pr-3 text-xs">{a.address ?? "—"}</td>
                      <td className="py-2.5 pr-3 text-xs">{a.assignedName ?? "—"}</td>
                      <td className="py-2.5">
                        {canWrite ? (
                          <select value={a.status} disabled={busy} onChange={(e) => void setStatus(a.id, e.target.value)} className={`${input} py-1 text-xs`}>
                            {APPOINTMENT_STATUSES.map((s) => <option key={s} value={s}>{APPOINTMENT_STATUS_LABELS[s]}</option>)}
                          </select>
                        ) : (
                          <span className="text-xs">{APPOINTMENT_STATUS_LABELS[a.status]}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
