"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { embedStyles, parseEmbedBranding, resolveEmbedTheme, themeLogoUrl, type EmbedBranding } from "./embed-branding";

const inputClass = "w-full px-3 py-2 text-sm placeholder:opacity-40";

/** Embeddable lead-capture form — creates leads in the org via the embed API. */
export function EmbedLeadWidget() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", phone: "", projectDescription: "" });
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [branding, setBranding] = useState<EmbedBranding | null>(null);
  const [error, setError] = useState(token ? "" : "Missing embed token. This widget must be loaded through the Revenue Rescue embed loader.");

  const theme = useMemo(() => resolveEmbedTheme(branding, searchParams), [branding, searchParams]);
  const s = useMemo(() => embedStyles(theme, branding), [branding, theme]);
  const logo = themeLogoUrl(theme, branding);

  useEffect(() => {
    if (typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage({ type: "rr:resize", height: document.documentElement.scrollHeight }, "*");
    }
  });

  useEffect(() => {
    if (!token) return;
    fetch("/api/embed/branding", { headers: { authorization: `Bearer ${token}` }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => body && setBranding(parseEmbedBranding(body)))
      .catch(() => {});
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || state === "busy") return;
    if (!form.email.trim() && !form.phone.trim()) {
      setError("Please provide an email or a phone number.");
      return;
    }
    setState("busy");
    setError("");
    try {
      const res = await fetch("/api/embed/leads", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok && res.status !== 409) {
        setError(body?.error?.message ?? "Something went wrong. Please try again.");
        setState("idle");
        return;
      }
      setState("done");
    } catch {
      setError("Something went wrong. Please try again.");
      setState("idle");
    }
  };

  if (state === "done") {
    return (
      <div className="p-5" style={s.root}>
        <div className="p-6 text-center" style={s.card}>
          <p className="text-lg font-bold">Thanks — we got your request.</p>
          <p className="mt-2 text-sm" style={s.muted}>Our team will reach out shortly.</p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 p-5" style={s.root}>
      <div className="flex items-center gap-2.5">
        {logo && (
          // eslint-disable-next-line @next/next/no-img-element -- external client logo, unknown host
          <img src={logo} alt="" className="h-6 w-auto" />
        )}
        <p className="text-sm font-bold">{branding?.displayName ? `Request a free estimate from ${branding.displayName}` : "Request a free estimate"}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <input className={inputClass} style={s.input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        <input className={inputClass} style={s.input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
      </div>
      <input className={inputClass} style={s.input} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <input className={inputClass} style={s.input} type="tel" placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <textarea className={inputClass} style={s.input} rows={3} placeholder="What do you need help with?" value={form.projectDescription} onChange={(e) => setForm({ ...form, projectDescription: e.target.value })} />
      {error && <p className="text-xs" style={s.error}>{error}</p>}
      <button type="submit" disabled={state === "busy" || !token} className="w-full px-4 py-2.5 text-sm font-bold disabled:opacity-50" style={s.accentSolid}>
        {state === "busy" ? "Sending…" : "Get my estimate"}
      </button>
      {(branding?.poweredBy.show ?? true) && (
        <p className="text-center text-[10px] uppercase tracking-wider" style={s.faint}>{branding?.poweredBy.label ?? "Powered by MogulForge Revenue Rescue"}</p>
      )}
    </form>
  );
}
