"use client";
import { useState } from "react";

const input = "mt-1 block w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white";

/** Public booking form posted to /api/book/[token]. No session required. */
export function PublicBookingForm({ token }: { token: string }) {
  const [form, setForm] = useState({ name: "", email: "", phone: "", scheduledStart: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/book/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, scheduledStart: form.scheduledStart ? new Date(form.scheduledStart).toISOString() : "" }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setError(body?.error ?? "The appointment could not be booked."); return; }
      setDone(true);
    } catch {
      setError("The appointment could not be booked. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className="rounded-xl border border-forge-lime/40 bg-forge-lime/10 px-4 py-4 text-sm text-forge-lime">
        Thanks — your appointment request is in. We&apos;ll be in touch to confirm.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && <p className="rounded-xl border border-forge-rust/40 bg-forge-rust/10 px-4 py-3 text-sm text-forge-rust">{error}</p>}
      <label className="block text-xs text-white/55">Your name
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} required maxLength={160} />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-xs text-white/55">Email
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={input} />
        </label>
        <label className="block text-xs text-white/55">Phone
          <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={input} />
        </label>
      </div>
      <label className="block text-xs text-white/55">Preferred date &amp; time
        <input type="datetime-local" value={form.scheduledStart} onChange={(e) => setForm({ ...form, scheduledStart: e.target.value })} className={input} required />
      </label>
      <label className="block text-xs text-white/55">Anything we should know?
        <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={input} rows={3} maxLength={1000} />
      </label>
      <button type="submit" disabled={busy || !form.name || !form.scheduledStart || (!form.email && !form.phone)} className="btn-primary w-full px-4 py-2.5 text-sm disabled:opacity-40">
        {busy ? "Booking…" : "Request appointment"}
      </button>
      <p className="text-[11px] text-white/35">Provide an email or phone number so we can confirm your booking.</p>
    </form>
  );
}
