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

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-6";
const input = "rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white";

export function RescueAppointmentsPanel({ orgId, canWrite }: { orgId: string; canWrite: boolean }) {
  const searchParams = useSearchParams();
  const orgSuffix = searchParams.get("org") ? `?org=${searchParams.get("org")}` : "";
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [adapters, setAdapters] = useState<Adapter[]>([]);
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

  const upcoming = appointments.filter((a) => a.status === "requested" || a.status === "confirmed" || a.status === "rescheduled");
  const past = appointments.filter((a) => !upcoming.includes(a));

  return (
    <div className="space-y-6">
      {scoped && <p className="text-xs text-white/45">Showing appointments for your assigned leads only.</p>}
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
