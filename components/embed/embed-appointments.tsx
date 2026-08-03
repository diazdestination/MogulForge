"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DEFAULT_EMBED_STYLES, embedStyles, parseEmbedBranding, resolveEmbedTheme, type EmbedBranding } from "./embed-branding";

type EmbedAppointment = {
  id: string;
  appointmentType: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  status: string;
  address: string | null;
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

  const theme = useMemo(() => resolveEmbedTheme(branding, searchParams), [branding, searchParams]);
  const s = useMemo(() => (branding ? embedStyles(theme, branding) : DEFAULT_EMBED_STYLES), [branding, theme]);

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
      <div className="p-6" style={s.root}>
        <div className="p-5 text-sm" style={{ ...s.card, borderColor: "rgba(248,113,113,0.4)", ...s.error }}>{error}</div>
      </div>
    );
  }
  if (!appointments) return <div className="p-6 text-sm" style={{ ...s.root, ...s.muted }}>Loading appointments…</div>;

  const statusStyle = (status: string): React.CSSProperties => {
    if (status === "scheduled") return s.accentSoft;
    if (status === "cancelled") return { backgroundColor: "rgba(248,113,113,0.15)", color: theme.mode === "dark" ? "#fca5a5" : "#b91c1c", borderRadius: s.accentSoft.borderRadius };
    if (status === "no_show") return { backgroundColor: "rgba(251,191,36,0.15)", color: theme.mode === "dark" ? "#fcd34d" : "#92400e", borderRadius: s.accentSoft.borderRadius };
    return { backgroundColor: theme.mode === "dark" ? "rgba(255,255,255,0.1)" : "rgba(17,20,24,0.08)", ...s.muted, borderRadius: s.accentSoft.borderRadius };
  };

  return (
    <div className="space-y-4 p-5" style={s.root}>
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold">{branding?.displayName ? `${branding.displayName} — Appointments` : "Appointments"}</h1>
        {(branding?.poweredBy.show ?? true) && (
          <span className="text-[10px] uppercase tracking-wider" style={s.faint}>{branding?.poweredBy.label ?? "Powered by MogulForge"}</span>
        )}
      </div>
      {appointments.length === 0 ? (
        <div className="p-5 text-sm" style={{ ...s.card, ...s.muted }}>No appointments scheduled.</div>
      ) : (
        <div className="space-y-2">
          {appointments.map((appointment) => {
            const start = new Date(appointment.scheduledStart);
            return (
              <div key={appointment.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-5 py-3" style={s.card}>
                <div className="min-w-28">
                  <p className="text-sm font-bold">{start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
                  <p className="text-xs" style={s.muted}>{start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</p>
                </div>
                <div className="flex-1">
                  <p className="text-sm capitalize">{appointment.appointmentType.replace(/_/g, " ")}</p>
                  {appointment.address && <p className="text-xs" style={s.muted}>{appointment.address}</p>}
                </div>
                <span className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider" style={statusStyle(appointment.status)}>
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
