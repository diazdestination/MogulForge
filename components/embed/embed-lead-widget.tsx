"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { accentBg, parseEmbedBranding, type EmbedBranding } from "./embed-branding";

const input = "w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/30";

/** Embeddable lead-capture form — creates leads in the org via the embed API. */
export function EmbedLeadWidget() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", phone: "", projectDescription: "" });
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [branding, setBranding] = useState<EmbedBranding | null>(null);
  const [error, setError] = useState(token ? "" : "Missing embed token. This widget must be loaded through the Revenue Rescue embed loader.");

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
      <div className="p-5 text-white">
        <div className="rounded-2xl border border-forge-lime/30 bg-forge-lime/5 p-6 text-center">
          <p className="text-lg font-bold">Thanks — we got your request.</p>
          <p className="mt-2 text-sm text-white/60">Our team will reach out shortly.</p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3 p-5 text-white">
      <p className="text-sm font-bold">{branding?.displayName ? `Request a free estimate from ${branding.displayName}` : "Request a free estimate"}</p>
      <div className="grid grid-cols-2 gap-3">
        <input className={input} placeholder="First name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        <input className={input} placeholder="Last name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
      </div>
      <input className={input} type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <input className={input} type="tel" placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <textarea className={input} rows={3} placeholder="What do you need help with?" value={form.projectDescription} onChange={(e) => setForm({ ...form, projectDescription: e.target.value })} />
      {error && <p className="text-xs text-red-300">{error}</p>}
      <button type="submit" disabled={state === "busy" || !token} className="w-full rounded-lg bg-forge-lime px-4 py-2.5 text-sm font-bold text-black disabled:opacity-50" style={accentBg(branding)}>
        {state === "busy" ? "Sending…" : "Get my estimate"}
      </button>
      {(branding?.poweredBy.show ?? true) && (
        <p className="text-center text-[10px] uppercase tracking-wider text-white/30">{branding?.poweredBy.label ?? "Powered by MogulForge Revenue Rescue"}</p>
      )}
    </form>
  );
}
