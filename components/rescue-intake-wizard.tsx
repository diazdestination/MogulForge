"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, CheckCircle2, Download, FileSpreadsheet, UploadCloud, X } from "lucide-react";
import { CHANNEL_OPTIONS, LEAD_SOURCE_OPTIONS, TONE_OPTIONS, type RescueIntakeInput } from "@/lib/rescue-intake-schema";
import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES, fileExtension, isAcceptedExtension } from "@/lib/rescue-import/fields";
import type { ColumnMapping } from "@/lib/rescue-import/mapping";
import { RescueMappingTable, type MappingState } from "./rescue-mapping-table";

const STEPS = ["Company", "Lead sources", "Upload", "Mapping", "Preferences", "Confirmations", "Review"] as const;

type Preview = {
  fileName: string;
  fileType: string;
  rowCount: number;
  columns: string[];
  sampleRows: string[][];
  autoMapping: ColumnMapping[];
};

const inputCls = "w-full rounded-xl border border-white/15 bg-white/[.04] px-4 py-3 text-sm outline-none focus:border-forge-lime";
const labelCls = "grid gap-2 text-sm font-bold";

export function RescueIntakeWizard() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [company, setCompany] = useState({ name: "", website: "", industry: "", serviceArea: "", averageJobValue: "" });
  const [sources, setSources] = useState<string[]>([]);
  const [dormantEstimate, setDormantEstimate] = useState("");
  const [sourceNotes, setSourceNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<MappingState>({});
  const [prefs, setPrefs] = useState({ channels: ["sms", "email"], tone: "professional", approveBeforeSending: true });
  const [confirms, setConfirms] = useState({ ownsData: false, hasContactPermission: false, honorsOptOuts: false });

  const mappedTargets = new Set(Object.values(mapping).filter(Boolean));
  const hasContactField = mappedTargets.has("email") || mappedTargets.has("phone");

  async function handleFile(selected: File) {
    setError("");
    const ext = fileExtension(selected.name);
    if (!isAcceptedExtension(ext)) {
      setError("Unsupported file type. Upload a .csv, .xlsx, .xls, or .json file.");
      return;
    }
    if (selected.size > MAX_UPLOAD_BYTES) {
      setError(`That file is ${(selected.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setPreviewLoading(true);
    try {
      const form = new FormData();
      form.append("file", selected);
      const res = await fetch("/api/revenue-rescue/intake/preview", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not read that file.");
        return;
      }
      setFile(selected);
      setPreview(body);
      setMapping(Object.fromEntries((body.autoMapping as ColumnMapping[]).map((c) => [c.sourceColumn, c.target])));
    } catch {
      setError("Could not read that file. Check your connection and try again.");
    } finally {
      setPreviewLoading(false);
    }
  }

  function clearFile() {
    setFile(null);
    setPreview(null);
    setMapping({});
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function validateStep(current: number): string {
    if (current === 0) {
      if (company.name.trim().length < 2) return "Enter your company name.";
      if (company.industry.trim().length < 2) return "Enter your industry or trade.";
      if (company.serviceArea.trim().length < 2) return "Enter your service area.";
      if (company.averageJobValue && !(Number(company.averageJobValue) > 0)) return "Average job value must be a positive number.";
    }
    if (current === 1 && sources.length === 0) return "Pick at least one place your old leads live.";
    if (current === 3 && preview && !hasContactField) return "Map at least one contact column — email or phone.";
    if (current === 4 && prefs.channels.length === 0) return "Pick at least one outreach channel.";
    if (current === 5 && !(confirms.ownsData && confirms.hasContactPermission && confirms.honorsOptOuts)) {
      return "All three confirmations are required before we can process your lead data.";
    }
    return "";
  }

  function next() {
    const message = validateStep(step);
    if (message) {
      setError(message);
      return;
    }
    setError("");
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  async function submit() {
    for (let s = 0; s < STEPS.length; s++) {
      const message = validateStep(s);
      if (message) {
        setError(message);
        setStep(s);
        return;
      }
    }
    setError("");
    setSubmitting(true);
    try {
      const intake: RescueIntakeInput = {
        company: {
          name: company.name.trim(),
          website: company.website.trim(),
          industry: company.industry.trim(),
          serviceArea: company.serviceArea.trim(),
          averageJobValue: company.averageJobValue ? Number(company.averageJobValue) : null,
        },
        leadSources: {
          sources: sources as RescueIntakeInput["leadSources"]["sources"],
          estimatedDormantLeads: dormantEstimate ? Number(dormantEstimate) : null,
          notes: sourceNotes.trim(),
        },
        campaignPreferences: prefs as RescueIntakeInput["campaignPreferences"],
        confirmations: { ownsData: true, hasContactPermission: true, honorsOptOuts: true },
      };
      const form = new FormData();
      form.append("intake", JSON.stringify(intake));
      if (file && preview) {
        form.append("file", file);
        form.append("mapping", JSON.stringify(mapping));
      }
      const res = await fetch("/api/revenue-rescue/intake", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Submission failed. Review the steps and try again.");
        setSubmitting(false);
        return;
      }
      router.push(`/dashboard/revenue-rescue/imports?org=${body.organizationId}${body.importId ? "&highlight=" + body.importId : ""}`);
    } catch {
      setError("Submission failed. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  return (
    <div className="rounded-[2rem] border border-white/10 bg-white/[.03] p-6 sm:p-10">
      {/* Progress indicator */}
      <ol className="flex flex-wrap gap-2">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full border text-xs font-extrabold ${
                i < step ? "border-forge-lime bg-forge-lime text-forge-ink" : i === step ? "border-forge-lime text-forge-lime" : "border-white/20 text-white/35"
              }`}
            >
              {i < step ? "✓" : i + 1}
            </span>
            <span className={`hidden text-xs font-bold uppercase tracking-wider sm:inline ${i === step ? "text-white" : "text-white/35"}`}>{label}</span>
            {i < STEPS.length - 1 && <span className="hidden h-px w-4 bg-white/15 sm:inline-block" />}
          </li>
        ))}
      </ol>

      <div className="mt-8 min-h-[320px]">
        {step === 0 && (
          <div className="grid gap-5 sm:grid-cols-2">
            <h2 className="font-display text-3xl font-semibold sm:col-span-2">Tell us about your company</h2>
            <label className={labelCls}>Company name<input value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} className={inputCls} placeholder="Summit Roofing Co." /></label>
            <label className={labelCls}>Website <span className="font-normal text-white/40">(optional)</span><input value={company.website} onChange={(e) => setCompany({ ...company, website: e.target.value })} className={inputCls} placeholder="summitroofing.com" /></label>
            <label className={labelCls}>Industry / trade<input value={company.industry} onChange={(e) => setCompany({ ...company, industry: e.target.value })} className={inputCls} placeholder="Roofing" /></label>
            <label className={labelCls}>Service area<input value={company.serviceArea} onChange={(e) => setCompany({ ...company, serviceArea: e.target.value })} className={inputCls} placeholder="Greater Columbus, OH" /></label>
            <label className={labelCls}>Average job value ($) <span className="font-normal text-white/40">(optional)</span><input type="number" min="1" value={company.averageJobValue} onChange={(e) => setCompany({ ...company, averageJobValue: e.target.value })} className={inputCls} placeholder="12000" /></label>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="font-display text-3xl font-semibold">Where do your old leads live?</h2>
            <p className="mt-2 text-sm text-white/50">Pick everything that applies — this shapes what we look for during cleanup.</p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {LEAD_SOURCE_OPTIONS.map((option) => (
                <label key={option.value} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold ${sources.includes(option.value) ? "border-forge-lime/60 bg-forge-lime/[.08]" : "border-white/10 bg-white/[.03]"}`}>
                  <input type="checkbox" checked={sources.includes(option.value)} onChange={() => setSources(toggle(sources, option.value))} className="h-4 w-4 accent-[#c9f75d]" />
                  {option.label}
                </label>
              ))}
            </div>
            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              <label className={labelCls}>Roughly how many dormant leads? <span className="font-normal text-white/40">(optional)</span><input type="number" min="0" value={dormantEstimate} onChange={(e) => setDormantEstimate(e.target.value)} className={inputCls} placeholder="1000" /></label>
              <label className={labelCls}>Anything we should know? <span className="font-normal text-white/40">(optional)</span><input value={sourceNotes} onChange={(e) => setSourceNotes(e.target.value)} className={inputCls} placeholder="Two CRMs merged last year…" /></label>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="font-display text-3xl font-semibold">Upload your lead file</h2>
            <p className="mt-2 text-sm text-white/50">CSV, Excel (.xlsx / .xls), or JSON — up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB. Files are stored privately and only used to build your lead database.</p>
            {!preview && (
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const dropped = e.dataTransfer.files?.[0]; if (dropped) void handleFile(dropped); }}
                onClick={() => fileInputRef.current?.click()}
                className={`mt-6 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition ${dragOver ? "border-forge-lime bg-forge-lime/[.06]" : "border-white/20 bg-white/[.02] hover:border-white/40"}`}
              >
                <UploadCloud className="text-forge-lime" size={34} />
                <p className="text-sm font-bold">{previewLoading ? "Reading your file…" : "Drag & drop your file here, or click to browse"}</p>
                <p className="text-xs text-white/40">.{ACCEPTED_EXTENSIONS.join("  ·  .")}</p>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.json" className="hidden" onChange={(e) => { const selected = e.target.files?.[0]; if (selected) void handleFile(selected); }} />
            {preview && (
              <div className="mt-6 rounded-2xl border border-forge-lime/30 bg-forge-lime/[.05] p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <FileSpreadsheet className="text-forge-lime" size={22} />
                    <div>
                      <p className="text-sm font-extrabold">{preview.fileName}</p>
                      <p className="text-xs text-white/50">{preview.rowCount.toLocaleString()} data rows · {preview.columns.length} columns</p>
                    </div>
                  </div>
                  <button type="button" onClick={clearFile} className="inline-flex items-center gap-1 rounded-full border border-white/20 px-3 py-1.5 text-xs font-bold text-white/60 hover:border-forge-rust hover:text-forge-rust"><X size={13} /> Remove</button>
                </div>
                <p className="mt-4 text-xs font-bold uppercase tracking-wider text-white/45">Columns found</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {preview.columns.map((column) => <span key={column} className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70">{column}</span>)}
                </div>
              </div>
            )}
            <div className="mt-6 flex flex-wrap items-center gap-4 text-sm">
              <a href="/api/revenue-rescue/template" className="inline-flex items-center gap-2 font-bold text-forge-lime hover:underline"><Download size={15} /> Download the sample CSV template</a>
              <span className="text-white/35">No file handy? You can skip this and upload from your dashboard later.</span>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="font-display text-3xl font-semibold">Match your columns to lead fields</h2>
            {preview ? (
              <>
                <p className="mt-2 text-sm text-white/50">We auto-matched what we could. Fix anything that looks wrong — at least one contact column (email or phone) is required.</p>
                <div className="mt-6"><RescueMappingTable autoMapping={preview.autoMapping} mapping={mapping} onChange={setMapping} /></div>
                {!hasContactField && <p className="mt-4 text-sm font-bold text-forge-rust">Map at least one contact column — email or phone.</p>}
              </>
            ) : (
              <p className="mt-4 rounded-xl border border-white/10 bg-white/[.03] p-5 text-sm text-white/55">No file uploaded — nothing to map. When you upload a file from your dashboard, you&rsquo;ll match columns there.</p>
            )}
          </div>
        )}

        {step === 4 && (
          <div>
            <h2 className="font-display text-3xl font-semibold">How should follow-up work?</h2>
            <p className="mt-2 text-sm text-white/50">These preferences shape the campaigns we prepare for your approval. Nothing sends without you.</p>
            <p className="mt-6 text-xs font-bold uppercase tracking-wider text-white/45">Outreach channels</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              {CHANNEL_OPTIONS.map((option) => (
                <label key={option.value} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold ${prefs.channels.includes(option.value) ? "border-forge-lime/60 bg-forge-lime/[.08]" : "border-white/10 bg-white/[.03]"}`}>
                  <input type="checkbox" checked={prefs.channels.includes(option.value)} onChange={() => setPrefs({ ...prefs, channels: toggle(prefs.channels, option.value) })} className="h-4 w-4 accent-[#c9f75d]" />
                  {option.label}
                </label>
              ))}
            </div>
            <p className="mt-6 text-xs font-bold uppercase tracking-wider text-white/45">Message tone</p>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              {TONE_OPTIONS.map((option) => (
                <label key={option.value} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold ${prefs.tone === option.value ? "border-forge-lime/60 bg-forge-lime/[.08]" : "border-white/10 bg-white/[.03]"}`}>
                  <input type="radio" name="tone" checked={prefs.tone === option.value} onChange={() => setPrefs({ ...prefs, tone: option.value })} className="h-4 w-4 accent-[#c9f75d]" />
                  {option.label}
                </label>
              ))}
            </div>
            <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/[.03] px-4 py-4 text-sm">
              <input type="checkbox" checked={prefs.approveBeforeSending} onChange={(e) => setPrefs({ ...prefs, approveBeforeSending: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[#c9f75d]" />
              <span><span className="font-bold">Require my approval before anything sends.</span><span className="block text-white/50">Recommended. Campaigns are prepared and wait for your sign-off.</span></span>
            </label>
          </div>
        )}

        {step === 5 && (
          <div>
            <h2 className="font-display text-3xl font-semibold">Data confirmations</h2>
            <p className="mt-2 text-sm text-white/50">Confirm how this lead data was collected. All three are required.</p>
            <div className="mt-6 space-y-3">
              {(
                [
                  ["ownsData", "I confirm this lead data belongs to my business — it was collected through our own estimates, calls, forms, and CRM records."],
                  ["hasContactPermission", "I confirm these contacts did business with us or asked us for a quote, and I have the right to follow up with them."],
                  ["honorsOptOuts", "I understand that anyone who has opted out will be suppressed from outreach, and opt-outs in my file are honored automatically."],
                ] as const
              ).map(([key, text]) => (
                <label key={key} className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-4 text-sm leading-6 ${confirms[key] ? "border-forge-lime/50 bg-forge-lime/[.06]" : "border-white/10 bg-white/[.03]"}`}>
                  <input type="checkbox" checked={confirms[key]} onChange={(e) => setConfirms({ ...confirms, [key]: e.target.checked })} className="mt-1 h-4 w-4 accent-[#c9f75d]" />
                  {text}
                </label>
              ))}
            </div>
          </div>
        )}

        {step === 6 && (
          <div>
            <h2 className="font-display text-3xl font-semibold">Review & submit</h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-white/[.03] p-5 text-sm">
                <p className="text-xs font-bold uppercase tracking-wider text-white/45">Company</p>
                <p className="mt-2 font-extrabold">{company.name}</p>
                <p className="text-white/55">{company.industry} · {company.serviceArea}</p>
                {company.averageJobValue && <p className="text-white/55">Avg job ${Number(company.averageJobValue).toLocaleString()}</p>}
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[.03] p-5 text-sm">
                <p className="text-xs font-bold uppercase tracking-wider text-white/45">Lead sources</p>
                <p className="mt-2 text-white/70">{sources.map((s) => LEAD_SOURCE_OPTIONS.find((o) => o.value === s)?.label).join(", ")}</p>
                {dormantEstimate && <p className="text-white/55">≈{Number(dormantEstimate).toLocaleString()} dormant leads</p>}
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[.03] p-5 text-sm">
                <p className="text-xs font-bold uppercase tracking-wider text-white/45">Lead file</p>
                {preview ? (
                  <>
                    <p className="mt-2 font-extrabold">{preview.fileName}</p>
                    <p className="text-white/55">{preview.rowCount.toLocaleString()} rows · {Object.values(mapping).filter(Boolean).length} columns mapped</p>
                  </>
                ) : (
                  <p className="mt-2 text-white/55">No file — you&rsquo;ll upload from your dashboard.</p>
                )}
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[.03] p-5 text-sm">
                <p className="text-xs font-bold uppercase tracking-wider text-white/45">Follow-up preferences</p>
                <p className="mt-2 text-white/70">{prefs.channels.map((c) => CHANNEL_OPTIONS.find((o) => o.value === c)?.label).join(", ")}</p>
                <p className="text-white/55">{TONE_OPTIONS.find((o) => o.value === prefs.tone)?.label}{prefs.approveBeforeSending ? " · approval required" : ""}</p>
              </div>
            </div>
            <p className="mt-5 flex items-center gap-2 text-sm text-white/50"><CheckCircle2 size={16} className="text-forge-lime" /> All three data confirmations checked.</p>
          </div>
        )}
      </div>

      {error && <p role="alert" className="mt-6 rounded-xl border border-forge-rust/30 bg-forge-rust/10 p-4 text-sm text-forge-rust">{error}</p>}

      <div className="mt-8 flex items-center justify-between border-t border-white/10 pt-6">
        <button type="button" onClick={() => { setError(""); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0 || submitting} className="btn-secondary disabled:opacity-30">
          <ArrowLeft size={16} /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" onClick={next} disabled={previewLoading} className="btn-primary">Continue <ArrowRight size={16} /></button>
        ) : (
          <button type="button" onClick={() => void submit()} disabled={submitting} className="btn-primary">{submitting ? "Setting up your workspace…" : "Submit & build my lead database"}</button>
        )}
      </div>
    </div>
  );
}
