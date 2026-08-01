"use client";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { parseEmbedBranding, type EmbedBranding } from "./embed-branding";

type EmbedAppointment = {
  id: string;
  appointmentType: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  status: string;
  address: string | null;
};

const box = "rounded-2xl border border-white/10 bg-white/[0.03] p-5";

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-forge-lime/15 text-forge-lime",
  completed: "bg-white/10 text-white/70",
  cancelled: "bg-red-400/15 text-red-300",
  no_show: "bg-amber-400/15 text-amber-300",
};

function postHeight() {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ type: "rr:resize", height: document.documentElement.scrollHeight }, "*");
}

/** Reads the embed token from ?token=, loads appointments, and renders the appointments module. */
export function EmbedAppointments() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [appointments, setAppointments] = useState<EmbedAppointment[] | null>(null);
  const [branding, setBranding] = useState<EmbedBranding | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!token) {
      setError("Missing embed token. This module must be loaded through the Revenue Rescue embed loader.");
      return;
    }
    try {
      const res = await fetch("/api/embed/appointments", { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? "This embed session is no longer valid.");
        return;
      }
      setAppointments(body.data ?? []);
      setBranding(parseEmbedBranding(body));
      setError("");
    } catch {
      setError("Could not load appointments.");
    }
  }, [token]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);
  useEffect(() => {
    postHeight();
  });

  if (error) {
    return (
      <div className="p-6">
        <div className={`${box} border-red-400/30 text-sm text-red-200`}>{error}</div>
      </div>
    );
  }
  if (!appointments) return <div className="p-6 text-sm text-white/50">Loading appointments…</div>;

  return (
    <div className="space-y-4 p-5 text-white">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold">{branding?.displayName ? `${branding.displayName} — Appointments` : "Appointments"}</h1>
        {(branding?.poweredBy.show ?? true) && (
          <span className="text-[10px] uppercase tracking-wider text-white/40">{branding?.poweredBy.label ?? "Powered by MogulForge"}</span>
        )}
      </div>
      {appointments.length === 0 ? (
        <div className={`${box} text-sm text-white/50`}>No appointments scheduled.</div>
      ) : (
        <div className="space-y-2">
          {appointments.map((appointment) => {
            const start = new Date(appointment.scheduledStart);
            return (
              <div key={appointment.id} className={`${box} flex flex-wrap items-center gap-x-4 gap-y-1 py-3`}>
                <div className="min-w-28">
                  <p className="text-sm font-bold">{start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
                  <p className="text-xs text-white/50">{start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</p>
                </div>
                <div className="flex-1">
                  <p className="text-sm capitalize">{appointment.appointmentType.replace(/_/g, " ")}</p>
                  {appointment.address && <p className="text-xs text-white/50">{appointment.address}</p>}
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLES[appointment.status] ?? "bg-white/10 text-white/70"}`}>
                  {appointment.status.replace(/_/g, " ")}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
