"use client";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { VisibilityInput, VisibilityReport } from "@/lib/visibility-schema";
import { createSubmitTimer } from "@/lib/bot-trap";
import { VisibilityReportView } from "@/components/visibility-report";

// `website` is a honeypot field hidden from humans; bots that auto-fill every
// input reveal themselves by populating it.
type VisibilityFormValues = VisibilityInput & { website?: string };

export function VisibilityForm() {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<VisibilityFormValues>();
  const [result, setResult] = useState<VisibilityReport | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [timer] = useState(createSubmitTimer);
  useEffect(() => { timer.start(); }, [timer]);

  const submit = async (data: VisibilityFormValues) => {
    setError("");
    const res = await fetch("/api/ai-visibility", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...data, elapsedMs: timer.elapsedMs() }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) { setError(body?.error ?? "Unable to run the scan."); return; }
    if (!body?.result) { setError("Unable to run the scan. Please try again."); return; }
    setResult(body.result);
    setReportId(body.reportId ?? null);
  };

  const copyShareLink = async () => {
    if (!reportId) return;
    const link = `${window.location.origin}/ai-visibility/r/${reportId}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt("Copy your share link:", link);
    }
  };

  if (result) return <div className="rounded-[2rem] border border-forge-lime/30 bg-white/[.04] p-7 sm:p-10 print:border-0 print:bg-white print:p-0">
    <VisibilityReportView report={result} />
    <div className="mt-7 flex flex-wrap gap-3 print:hidden">
      <button onClick={() => { setResult(null); setReportId(null); }} className="btn-secondary">Scan another site</button>
      {reportId && <button onClick={copyShareLink} className="btn-secondary">{copied ? "Link copied!" : "Copy share link"}</button>}
      {reportId
        ? <a href={`/api/ai-visibility/${reportId}/pdf`} download className="btn-secondary">Download PDF</a>
        : <button onClick={() => window.print()} className="btn-secondary">Download PDF</button>}
    </div>
  </div>;

  return <form onSubmit={handleSubmit(submit)} className="grid gap-5 rounded-[2rem] border border-white/10 bg-white/[.03] p-6 sm:p-10">
    {/* Honeypot: invisible to humans (off-screen, untabbable), so anything typed here means a bot. */}
    <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
      <label>Leave this field empty
        <input {...register("website")} type="text" tabIndex={-1} autoComplete="off" />
      </label>
    </div>
    <label className="grid gap-2 text-sm font-bold">Website address
      <input {...register("url", { required: true })} type="text" inputMode="url" placeholder="example.com" className="rounded-xl border border-white/15 bg-transparent px-4 py-3 outline-none focus:border-forge-lime" />
      {errors.url && <span className="text-xs text-forge-rust">Enter your website address.</span>}
    </label>
    <label className="grid gap-2 text-sm font-bold">Work email
      <input {...register("email", { required: true, pattern: /.+@.+\..+/ })} type="email" placeholder="you@company.com" className="rounded-xl border border-white/15 bg-transparent px-4 py-3 outline-none focus:border-forge-lime" />
      {errors.email && <span className="text-xs text-forge-rust">Enter a valid email so we can send your report.</span>}
    </label>
    {error && <p role="alert" className="rounded-xl border border-forge-rust/30 bg-forge-rust/10 p-4 text-sm text-forge-rust">{error}</p>}
    <button disabled={isSubmitting} className="btn-primary" type="submit">{isSubmitting ? "Crawling your site and scoring AI signals…" : "Scan my AI visibility"}</button>
    <p className="text-center text-xs text-white/35">We fetch your live homepage, robots.txt, sitemap, and llms.txt. Your report is saved so you can revisit and share it.</p>
  </form>;
}
