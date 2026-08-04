"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Building2,
  CalendarDays,
  CheckCircle2,
  FileSpreadsheet,
  Globe,
  Plug,
  RefreshCw,
  UploadCloud,
} from "lucide-react";
import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES, fileExtension, isAcceptedExtension } from "@/lib/rescue-import/fields";
import { isProcessingStatus } from "@/lib/rescue-import/status";
import type { ColumnMapping } from "@/lib/rescue-import/mapping";
import { RescueMappingTable, type MappingState } from "./rescue-mapping-table";

/**
 * Guided onboarding wizard. Company basics create (or reuse) the org; the
 * Google / leads / website steps are all skippable and record only the user's
 * choice — the final status screen re-fetches LIVE connection state and never
 * presents a "done" flag as proof something works.
 */

type StepChoice = "done" | "skipped";
type OnboardingRecordShape = { started: boolean; steps: Partial<Record<"google" | "leads" | "website", StepChoice>>; completedAt: string | null };
type OnboardingStatusShape = {
  googleConfigured: boolean;
  google: { connected: boolean; accountEmail: string | null };
  leads: { activeCrmProviders: string[]; hasCrmConnection: boolean; leadCount: number };
  website: { origins: string[]; websiteUrl: string };
  calendar: { syncProvider: string; orgConnected: boolean; workspaceConnected: boolean; calendlyUrl: string };
};

type ImportRecord = {
  id: string;
  fileName: string;
  status: string;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  suppressedCount: number;
  invalidCount: number;
  autoMapping: ColumnMapping[];
  error: string | null;
};

type PullSummary = { ok: boolean; message: string; matched: number; updated: number; conflicts: number; unmatched: number };

const STEPS = [
  { key: "company", label: "Company" },
  { key: "google", label: "Google" },
  { key: "leads", label: "Leads" },
  { key: "website", label: "Website" },
  { key: "summary", label: "Status" },
] as const;

function normalizeOrigin(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

const CARD = "rounded-2xl border border-white/10 bg-white/[.03] p-6";
const GREEN_BOX = "rounded-xl border border-forge-lime/40 bg-forge-lime/5 px-4 py-3 text-sm text-forge-lime";
const AMBER_BOX = "rounded-xl border border-amber-400/40 bg-amber-400/5 px-4 py-3 text-sm text-amber-200";
const RUST_BOX = "rounded-xl border border-forge-rust/50 bg-forge-rust/5 px-4 py-3 text-sm text-forge-rust";
const PRIMARY_BTN = "rounded-full bg-forge-lime px-6 py-2.5 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-50";
const GHOST_BTN = "rounded-full border border-white/15 px-5 py-2.5 text-sm font-bold text-white/60 transition hover:border-white/40 hover:text-white";
const INPUT = "w-full rounded-xl border border-white/15 bg-black/30 px-4 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-forge-lime/60 focus:outline-none";

export function OnboardingWizard({
  userName,
  org: initialOrg,
  initialRecord,
  initialStatus,
  feedback,
  requestedStep,
}: {
  userName: string;
  org: { id: string; name: string; industry: string; website: string } | null;
  initialRecord: OnboardingRecordShape | null;
  initialStatus: OnboardingStatusShape | null;
  feedback: { calendar: string | null; reason: string | null };
  requestedStep: string | null;
}) {
  const router = useRouter();
  const [org, setOrg] = useState(initialOrg);
  // Step choices are tracked so PATCH responses stay authoritative, even though
  // rendering decisions below key off live status rather than these flags.
  const [, setRecord] = useState<OnboardingRecordShape>(initialRecord ?? { started: false, steps: {}, completedAt: null });
  const [status, setStatus] = useState<OnboardingStatusShape | null>(initialStatus);

  const [stepIndex, setStepIndex] = useState(() => {
    if (!initialOrg) return 0;
    if (feedback.calendar || requestedStep === "google") return 1;
    if (requestedStep === "leads") return 2;
    if (requestedStep === "website") return 3;
    if (requestedStep === "summary") return 4;
    const steps = initialRecord?.steps ?? {};
    if (!steps.google) return 1;
    if (!steps.leads) return 2;
    if (!steps.website) return 3;
    return 4;
  });

  const refreshStatus = useCallback(async (orgId?: string) => {
    const id = orgId ?? org?.id;
    if (!id) return;
    try {
      const res = await fetch(`/api/orgs/${id}/onboarding`, { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      setRecord(body.record);
      setStatus(body.status);
    } catch {
      /* transient — keep last known state */
    }
  }, [org?.id]);

  async function markStep(step: "google" | "leads" | "website", choice: StepChoice, advance = true) {
    if (!org) return;
    try {
      const res = await fetch(`/api/orgs/${org.id}/onboarding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step, status: choice }),
      });
      if (res.ok) {
        const body = await res.json();
        setRecord(body.record);
      }
    } catch {
      /* progress flags are best-effort — never block the flow on them */
    }
    if (advance) setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  }

  // After a successful OAuth round-trip, record the choice once.
  const autoMarked = useRef(false);
  useEffect(() => {
    if (autoMarked.current || feedback.calendar !== "connected" || !org) return;
    autoMarked.current = true;
    void markStep("google", "done", false);
    void refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The summary screen always shows fresh, live-checked statuses.
  useEffect(() => {
    if (stepIndex === 4) void Promise.resolve().then(() => refreshStatus());
  }, [stepIndex, refreshStatus]);

  // ------------------------------------------------------------------ company
  const [companyName, setCompanyName] = useState(initialOrg?.name ?? "");
  const [industry, setIndustry] = useState(initialOrg?.industry ?? "");
  const [companyWebsite, setCompanyWebsite] = useState(initialOrg?.website ?? "");
  const [companyBusy, setCompanyBusy] = useState(false);
  const [companyError, setCompanyError] = useState("");

  async function submitCompany() {
    setCompanyError("");
    if (companyName.trim().length < 2) {
      setCompanyError("Please enter your company name.");
      return;
    }
    setCompanyBusy(true);
    try {
      const res = await fetch("/api/onboarding/company", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName: companyName.trim(),
          industry: industry.trim(),
          website: companyWebsite.trim(),
          // When the wizard already knows its org (resume/revisit, multi-org
          // managers), pin the request to it — the server never redirects
          // progress to a different org.
          ...(org ? { organizationId: org.id } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setCompanyError(body.error ?? "Could not save your company details.");
        return;
      }
      const orgId: string = body.organizationId;
      setOrg((prev) => prev ?? { id: orgId, name: companyName.trim(), industry: industry.trim(), website: companyWebsite.trim() });
      // Carry the website into the website step's input if it wasn't set yet.
      setWebsiteInput((prev) => prev || companyWebsite.trim());
      await refreshStatus(orgId);
      setStepIndex(1);
    } catch {
      setCompanyError("Could not save your company details. Check your connection and try again.");
    } finally {
      setCompanyBusy(false);
    }
  }

  // ------------------------------------------------------------------- leads
  const [leadsMode, setLeadsMode] = useState<"" | "crm" | "file">("");
  const [crmProvider, setCrmProvider] = useState<"hubspot" | "gohighlevel">("hubspot");
  const [crmToken, setCrmToken] = useState("");
  const [crmLocation, setCrmLocation] = useState("");
  const [crmBusy, setCrmBusy] = useState(false);
  const [crmError, setCrmError] = useState("");
  const [crmResult, setCrmResult] = useState<PullSummary | null>(null);

  async function connectCrm() {
    if (!org) return;
    setCrmError("");
    setCrmResult(null);
    if (!crmToken.trim() || (crmProvider === "gohighlevel" && !crmLocation.trim())) {
      setCrmError(crmProvider === "hubspot" ? "Paste your HubSpot private app access token." : "Paste your GoHighLevel token and location ID.");
      return;
    }
    setCrmBusy(true);
    try {
      const base = `/api/orgs/${org.id}/integrations/crm`;
      const createRes = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: crmProvider,
          name: crmProvider === "hubspot" ? "HubSpot" : "GoHighLevel",
          config: crmProvider === "hubspot" ? { accessToken: crmToken.trim() } : { apiKey: crmToken.trim(), locationId: crmLocation.trim() },
        }),
      });
      const createBody = await createRes.json();
      if (!createRes.ok) throw new Error(createBody.error ?? "Could not save the connection.");
      const cid: string = createBody.connection.id;

      const testRes = await fetch(`${base}/${cid}/test`, { method: "POST" });
      const testBody = await testRes.json().catch(() => null);
      if (!testRes.ok || !testBody?.result?.ok) {
        throw new Error(testBody?.result?.message ?? testBody?.error ?? "The connection test failed — check the credentials.");
      }

      const activateRes = await fetch(`${base}/${cid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active", syncDirection: "bidirectional" }),
      });
      if (!activateRes.ok) {
        const b = await activateRes.json().catch(() => null);
        throw new Error(b?.error ?? "The test passed but activation failed. Finish setup from Integrations.");
      }

      const pullRes = await fetch(`${base}/${cid}/pull`, { method: "POST" });
      const pullBody = await pullRes.json().catch(() => null);
      if (!pullRes.ok) {
        throw new Error(pullBody?.error ?? "Connected, but the first pull failed. The connection stays active — retry from Integrations.");
      }
      setCrmResult(pullBody.summary);
      await refreshStatus();
    } catch (error) {
      setCrmError(error instanceof Error ? error.message : "Something went wrong connecting your CRM.");
    } finally {
      setCrmBusy(false);
    }
  }

  const [importRecord, setImportRecord] = useState<ImportRecord | null>(null);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [mapping, setMapping] = useState<MappingState>({});
  const [uploadBusy, setUploadBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(file: File) {
    if (!org) return;
    setFileError("");
    const ext = fileExtension(file.name);
    if (!isAcceptedExtension(ext)) {
      setFileError("Unsupported file type. Upload a .csv, .xlsx, .xls, or .json file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setFileError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setUploadBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/orgs/${org.id}/imports`, { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        setFileError(body.error ?? "Upload failed.");
        return;
      }
      const rec: ImportRecord = body.import;
      setImportRecord(rec);
      setMappingConfirmed(false);
      setMapping(Object.fromEntries(rec.autoMapping.map((c) => [c.sourceColumn, c.target])));
    } catch {
      setFileError("Upload failed. Check your connection and try again.");
    } finally {
      setUploadBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function confirmMapping() {
    if (!org || !importRecord) return;
    setFileError("");
    setUploadBusy(true);
    try {
      const res = await fetch(`/api/orgs/${org.id}/imports/${importRecord.id}/mapping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping }),
      });
      const body = await res.json();
      if (!res.ok) {
        setFileError(body.error ?? "Could not save the mapping.");
        return;
      }
      setMappingConfirmed(true);
      setImportRecord((prev) => (prev ? { ...prev, status: "queued" } : prev));
    } catch {
      setFileError("Could not save the mapping. Try again.");
    } finally {
      setUploadBusy(false);
    }
  }

  const importProcessing = !!importRecord && mappingConfirmed && isProcessingStatus(importRecord.status);
  useEffect(() => {
    if (!importProcessing || !org) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/orgs/${org.id}/imports`, { cache: "no-store" });
        if (!res.ok) return;
        const body = await res.json();
        const fresh = (body.imports as ImportRecord[]).find((r) => r.id === importRecord?.id);
        if (fresh) setImportRecord(fresh);
      } catch {
        /* transient */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [importProcessing, org, importRecord?.id]);

  const importDone = !!importRecord && mappingConfirmed && !isProcessingStatus(importRecord.status) && importRecord.status !== "mapping_required";

  // ----------------------------------------------------------------- website
  const [websiteInput, setWebsiteInput] = useState(initialOrg?.website ?? "");
  const [websiteBusy, setWebsiteBusy] = useState(false);
  const [websiteError, setWebsiteError] = useState("");
  const [approvedOrigin, setApprovedOrigin] = useState("");
  const appOrigin = typeof window !== "undefined" ? window.location.origin : "";

  async function approveWebsite() {
    if (!org) return;
    setWebsiteError("");
    const origin = normalizeOrigin(websiteInput);
    if (!origin) {
      setWebsiteError("Enter a valid website address, e.g. https://www.yourcompany.com");
      return;
    }
    setWebsiteBusy(true);
    try {
      const res = await fetch(`/api/orgs/${org.id}/integrations/origins`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load your approved origins.");
      const existing: string[] = body.allowedOrigins ?? [];
      if (!existing.includes(origin)) {
        const patchRes = await fetch(`/api/orgs/${org.id}/integrations/origins`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowedOrigins: [...existing, origin] }),
        });
        const patchBody = await patchRes.json();
        if (!patchRes.ok) throw new Error(patchBody.error ?? "Could not approve that origin.");
      }
      // Best-effort: remember the website on the org profile too.
      void fetch(`/api/orgs/${org.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: { website: origin } }),
      }).catch(() => {});
      setApprovedOrigin(origin);
      await refreshStatus();
    } catch (error) {
      setWebsiteError(error instanceof Error ? error.message : "Could not approve that origin.");
    } finally {
      setWebsiteBusy(false);
    }
  }

  // ----------------------------------------------------------------- summary
  const [finishBusy, setFinishBusy] = useState(false);

  async function finish() {
    if (!org) return;
    setFinishBusy(true);
    try {
      await fetch(`/api/orgs/${org.id}/onboarding`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      });
    } catch {
      /* completion flag is cosmetic — never trap the user in the wizard */
    }
    router.push(`/dashboard/revenue-rescue?org=${org.id}`);
  }

  // ---------------------------------------------------------------- rendering
  const googleStatus = status?.google ?? { connected: false, accountEmail: null };
  const googleConfigured = status?.googleConfigured ?? false;

  return (
    <div>
      <p className="eyebrow">Welcome{userName ? `, ${userName.split(" ")[0]}` : ""}</p>
      <h1 className="mt-3 font-display text-4xl font-semibold sm:text-5xl">Let&rsquo;s get your workspace set up</h1>
      <p className="mt-3 max-w-xl text-sm text-white/55">
        Four quick steps — connect Google, bring your leads in, and hook up your website. Everything can be skipped and
        finished later from your dashboard.
      </p>

      {/* Step indicator */}
      <ol className="mt-8 flex flex-wrap items-center gap-2">
        {STEPS.map((step, i) => {
          const reachable = !!org || i === 0;
          const current = i === stepIndex;
          const past = i < stepIndex;
          return (
            <li key={step.key} className="flex items-center gap-2">
              <button
                type="button"
                disabled={!reachable}
                onClick={() => reachable && setStepIndex(i)}
                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold transition ${
                  current ? "border-forge-lime text-forge-lime" : past ? "border-white/30 text-white/70" : "border-white/12 text-white/40"
                } ${reachable ? "hover:border-white/40" : "cursor-not-allowed"}`}
              >
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${current ? "bg-forge-lime text-black" : "bg-white/10"}`}>
                  {i + 1}
                </span>
                {step.label}
              </button>
              {i < STEPS.length - 1 && <span className="text-white/20">→</span>}
            </li>
          );
        })}
      </ol>

      <div className="mt-8">
        {/* ------------------------------------------------ 1. Company basics */}
        {stepIndex === 0 && (
          <div className={CARD}>
            <div className="flex items-center gap-3">
              <Building2 className="h-5 w-5 text-forge-lime" />
              <h2 className="font-display text-2xl font-semibold">Your company</h2>
            </div>
            {initialOrg && (
              <p className={`mt-4 ${AMBER_BOX}`}>
                You already manage <strong>{initialOrg.name}</strong> — we&rsquo;ll set up that workspace.
              </p>
            )}
            <div className="mt-5 grid gap-4">
              <label className="grid gap-1.5 text-sm">
                <span className="font-bold text-white/70">Company name</span>
                <input className={INPUT} value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Summit Roofing Co." />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-bold text-white/70">What do you do?</span>
                <input className={INPUT} value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="Roofing, HVAC, plumbing, remodeling…" />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="font-bold text-white/70">Website (optional)</span>
                <input className={INPUT} value={companyWebsite} onChange={(e) => setCompanyWebsite(e.target.value)} placeholder="https://www.yourcompany.com" />
              </label>
            </div>
            {companyError && <p className={`mt-4 ${RUST_BOX}`}>{companyError}</p>}
            <div className="mt-6 flex items-center gap-3">
              <button type="button" className={PRIMARY_BTN} onClick={() => void submitCompany()} disabled={companyBusy}>
                {companyBusy ? "Saving…" : "Save & continue"}
              </button>
            </div>
          </div>
        )}

        {/* ------------------------------------------------ 2. Connect Google */}
        {stepIndex === 1 && org && (
          <div className={CARD}>
            <div className="flex items-center gap-3">
              <CalendarDays className="h-5 w-5 text-forge-lime" />
              <h2 className="font-display text-2xl font-semibold">Connect your Google account</h2>
            </div>
            <p className="mt-3 text-sm text-white/55">
              One sign-in powers appointment sync with <strong>your own</strong> Google Calendar and lays the groundwork
              for Gmail-based features later. We only ask for your email identity and calendar events — nothing is ever
              sent from your Gmail, and you can disconnect any time from Settings.
            </p>
            {feedback.calendar === "error" && (
              <p className={`mt-4 ${RUST_BOX}`}>Google connection failed{feedback.reason ? `: ${feedback.reason}` : "."} You can try again or skip for now.</p>
            )}
            <div className="mt-5">
              {!googleConfigured && !googleStatus.connected ? (
                <p className={AMBER_BOX}>
                  Google sign-in isn&rsquo;t available yet — the platform team still needs to configure the Google OAuth app
                  (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET). Skip this step and connect later from Settings once
                  it&rsquo;s ready.
                </p>
              ) : googleStatus.connected ? (
                <p className={GREEN_BOX}>
                  <CheckCircle2 className="mr-2 inline h-4 w-4" />
                  Connected as {googleStatus.accountEmail ?? "your Google account"}.
                </p>
              ) : (
                <a
                  href={`/api/orgs/${org.id}/calendar/oauth/google_calendar?returnTo=${encodeURIComponent(`/onboarding?step=google&org=${org.id}`)}`}
                  className={`${PRIMARY_BTN} inline-block`}
                >
                  Connect Google
                </a>
              )}
            </div>
            <div className="mt-6 flex items-center gap-3">
              {googleStatus.connected ? (
                <button type="button" className={PRIMARY_BTN} onClick={() => void markStep("google", "done")}>Continue</button>
              ) : (
                <button type="button" className={GHOST_BTN} onClick={() => void markStep("google", "skipped")}>Skip for now</button>
              )}
            </div>
          </div>
        )}

        {/* --------------------------------------------------- 3. Bring leads */}
        {stepIndex === 2 && org && (
          <div className={CARD}>
            <div className="flex items-center gap-3">
              <UploadCloud className="h-5 w-5 text-forge-lime" />
              <h2 className="font-display text-2xl font-semibold">Bring your leads in</h2>
            </div>
            <p className="mt-3 text-sm text-white/55">Upload your lead list, or connect your CRM for ongoing two-way sync. You can do both.</p>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setLeadsMode("file")}
                className={`rounded-xl border p-4 text-left transition ${leadsMode === "file" ? "border-forge-lime/60 bg-forge-lime/5" : "border-white/12 hover:border-white/30"}`}
              >
                <FileSpreadsheet className="h-5 w-5 text-forge-lime" />
                <p className="mt-2 text-sm font-bold">Upload a file</p>
                <p className="mt-1 text-xs text-white/50">CSV, Excel, or JSON — best way to bring your existing list in.</p>
              </button>
              <button
                type="button"
                onClick={() => setLeadsMode("crm")}
                className={`rounded-xl border p-4 text-left transition ${leadsMode === "crm" ? "border-forge-lime/60 bg-forge-lime/5" : "border-white/12 hover:border-white/30"}`}
              >
                <Plug className="h-5 w-5 text-forge-lime" />
                <p className="mt-2 text-sm font-bold">Connect your CRM</p>
                <p className="mt-1 text-xs text-white/50">HubSpot or GoHighLevel — keeps lead updates in sync both ways.</p>
              </button>
            </div>

            {leadsMode === "file" && (
              <div className="mt-6">
                {!importRecord && (
                  <div
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) void handleUpload(f); }}
                    className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${dragOver ? "border-forge-lime/70 bg-forge-lime/5" : "border-white/15"}`}
                  >
                    <UploadCloud className="h-8 w-8 text-white/40" />
                    <p className="mt-3 text-sm text-white/60">Drag a file here, or</p>
                    <button type="button" className={`mt-3 ${GHOST_BTN}`} onClick={() => fileInputRef.current?.click()} disabled={uploadBusy}>
                      {uploadBusy ? "Uploading…" : "Choose a file"}
                    </button>
                    <p className="mt-3 text-xs text-white/35">{ACCEPTED_EXTENSIONS.join(", ")} · up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB</p>
                    <input ref={fileInputRef} type="file" className="hidden" accept={ACCEPTED_EXTENSIONS.join(",")} onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload(f); }} />
                  </div>
                )}

                {importRecord && !mappingConfirmed && (
                  <div>
                    <p className="text-sm text-white/60">
                      Check how the columns in <strong>{importRecord.fileName}</strong> map to lead fields:
                    </p>
                    <div className="mt-3">
                      <RescueMappingTable autoMapping={importRecord.autoMapping} mapping={mapping} onChange={setMapping} />
                    </div>
                    <div className="mt-4 flex items-center gap-3">
                      <button type="button" className={PRIMARY_BTN} onClick={() => void confirmMapping()} disabled={uploadBusy}>
                        {uploadBusy ? "Starting…" : "Start import"}
                      </button>
                      <button type="button" className={GHOST_BTN} onClick={() => { setImportRecord(null); setMapping({}); }}>Different file</button>
                    </div>
                  </div>
                )}

                {importRecord && mappingConfirmed && isProcessingStatus(importRecord.status) && (
                  <p className={AMBER_BOX}>
                    <RefreshCw className="mr-2 inline h-4 w-4 animate-spin" />
                    Importing {importRecord.fileName} ({importRecord.rowCount} rows)…
                  </p>
                )}

                {importDone && importRecord.status !== "failed" && (
                  <p className={GREEN_BOX}>
                    <CheckCircle2 className="mr-2 inline h-4 w-4" />
                    {importRecord.importedCount} leads imported
                    {importRecord.duplicateCount > 0 ? ` · ${importRecord.duplicateCount} duplicates skipped` : ""}
                    {importRecord.invalidCount > 0 ? ` · ${importRecord.invalidCount} rows had problems` : ""}.
                  </p>
                )}
                {importDone && importRecord.status === "failed" && (
                  <div className={RUST_BOX}>
                    The import failed{importRecord.error ? `: ${importRecord.error}` : "."} You can retry from the Imports page later, or{" "}
                    <button type="button" className="font-bold underline" onClick={() => { setImportRecord(null); setMapping({}); setMappingConfirmed(false); }}>
                      try another file
                    </button>.
                  </div>
                )}
              </div>
            )}

            {leadsMode === "crm" && (
              <div className="mt-6 grid gap-4">
                <label className="grid gap-1.5 text-sm">
                  <span className="font-bold text-white/70">CRM</span>
                  <select className={INPUT} value={crmProvider} onChange={(e) => setCrmProvider(e.target.value as "hubspot" | "gohighlevel")}>
                    <option value="hubspot">HubSpot</option>
                    <option value="gohighlevel">GoHighLevel</option>
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="font-bold text-white/70">{crmProvider === "hubspot" ? "Private app access token" : "Private integration token"}</span>
                  <input className={INPUT} type="password" value={crmToken} onChange={(e) => setCrmToken(e.target.value)} placeholder={crmProvider === "hubspot" ? "pat-…" : "Token"} />
                </label>
                {crmProvider === "gohighlevel" && (
                  <label className="grid gap-1.5 text-sm">
                    <span className="font-bold text-white/70">Location ID</span>
                    <input className={INPUT} value={crmLocation} onChange={(e) => setCrmLocation(e.target.value)} placeholder="Location ID" />
                  </label>
                )}
                {crmError && <p className={RUST_BOX}>{crmError}</p>}
                {crmResult && (
                  <div className={GREEN_BOX}>
                    <CheckCircle2 className="mr-2 inline h-4 w-4" />
                    CRM connected and syncing. First pull: {crmResult.message}
                    {crmResult.unmatched > 0 && (status?.leads.leadCount ?? 0) === 0 && (
                      <span className="mt-1 block text-xs text-white/60">
                        Heads up: CRM sync updates leads that already exist here — it doesn&rsquo;t import new ones. Upload a file to bring your full list in.
                      </span>
                    )}
                  </div>
                )}
                {!crmResult && (
                  <div>
                    <button type="button" className={PRIMARY_BTN} onClick={() => void connectCrm()} disabled={crmBusy}>
                      {crmBusy ? "Connecting…" : "Connect & pull"}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="mt-6 flex items-center gap-3 border-t border-white/10 pt-5">
              {(importDone && importRecord?.status !== "failed") || crmResult ? (
                <button type="button" className={PRIMARY_BTN} onClick={() => void markStep("leads", "done")}>Continue</button>
              ) : (
                <button type="button" className={GHOST_BTN} onClick={() => void markStep("leads", "skipped")}>Skip for now</button>
              )}
              {fileError && <p className="text-sm text-forge-rust">{fileError}</p>}
            </div>
          </div>
        )}

        {/* ----------------------------------------------- 4. Connect website */}
        {stepIndex === 3 && org && (
          <div className={CARD}>
            <div className="flex items-center gap-3">
              <Globe className="h-5 w-5 text-forge-lime" />
              <h2 className="font-display text-2xl font-semibold">Connect your website</h2>
            </div>
            <p className="mt-3 text-sm text-white/55">
              Approve your website&rsquo;s address so it can embed your Revenue Rescue dashboard, lead views, and booking
              widgets. Embeds only render on approved origins — nowhere else.
            </p>
            <div className="mt-5 flex flex-wrap items-end gap-3">
              <label className="grid min-w-[260px] flex-1 gap-1.5 text-sm">
                <span className="font-bold text-white/70">Your website</span>
                <input className={INPUT} value={websiteInput} onChange={(e) => setWebsiteInput(e.target.value)} placeholder="https://www.yourcompany.com" />
              </label>
              <button type="button" className={PRIMARY_BTN} onClick={() => void approveWebsite()} disabled={websiteBusy}>
                {websiteBusy ? "Approving…" : "Approve & get my snippet"}
              </button>
            </div>
            {websiteError && <p className={`mt-4 ${RUST_BOX}`}>{websiteError}</p>}
            {approvedOrigin && (
              <div className="mt-5">
                <p className={GREEN_BOX}>
                  <CheckCircle2 className="mr-2 inline h-4 w-4" />
                  {approvedOrigin} is approved. Snippet ready — paste it into your site:
                </p>
                <pre className="mt-3 overflow-x-auto rounded-lg bg-black/50 p-3 font-mono text-xs text-white/70">{`<script src="${appOrigin}/embed/v1/loader.js" async></script>
<div data-rr-embed="dashboard" data-rr-token="TOKEN_FROM_YOUR_SERVER"></div>`}</pre>
                <p className="mt-2 text-xs text-white/45">
                  The token must be requested by your website&rsquo;s server (never the browser) — the full developer guide is
                  in{" "}
                  <Link href={`/dashboard/revenue-rescue/integrations?org=${org.id}`} className="font-bold underline">
                    Integrations
                  </Link>
                  . Prefer a fully hosted portal on your own address (like portal.yourcompany.com)? Set up a custom domain
                  later in Branding.
                </p>
              </div>
            )}
            <div className="mt-6 flex items-center gap-3 border-t border-white/10 pt-5">
              {approvedOrigin ? (
                <button type="button" className={PRIMARY_BTN} onClick={() => void markStep("website", "done")}>Continue</button>
              ) : (
                <button type="button" className={GHOST_BTN} onClick={() => void markStep("website", "skipped")}>Skip for now</button>
              )}
            </div>
          </div>
        )}

        {/* -------------------------------------------------- 5. Live summary */}
        {stepIndex === 4 && org && (
          <div className={CARD}>
            <h2 className="font-display text-2xl font-semibold">Where you stand</h2>
            <p className="mt-2 text-xs text-white/45">These are live checks — nothing shows green unless it&rsquo;s actually connected right now.</p>
            <div className="mt-5 grid gap-3">
              <StatusRow
                ok={googleStatus.connected}
                title="Google account"
                okText={`Connected as ${googleStatus.accountEmail ?? "your Google account"}`}
                pendingText={googleConfigured ? "Not connected — connect any time from Settings" : "Not available yet — Google sign-in isn't configured on the platform"}
              />
              <StatusRow
                ok={(status?.leads.leadCount ?? 0) > 0 || (status?.leads.activeCrmProviders.length ?? 0) > 0}
                title="Leads"
                okText={[
                  (status?.leads.leadCount ?? 0) > 0 ? `${status?.leads.leadCount} leads in your workspace` : "",
                  (status?.leads.activeCrmProviders.length ?? 0) > 0 ? `CRM sync active (${status?.leads.activeCrmProviders.join(", ")})` : "",
                ].filter(Boolean).join(" · ")}
                pendingText="No leads yet — upload a file or connect your CRM from the dashboard"
              />
              <StatusRow
                ok={(status?.website.origins.length ?? 0) > 0}
                title="Website"
                okText={`${status?.website.origins.length} approved origin${(status?.website.origins.length ?? 0) === 1 ? "" : "s"} — embed snippet ready`}
                pendingText="No approved origins yet — your site can't embed anything until one is approved"
              />
              <StatusRow
                ok={status?.calendar.syncProvider !== "none" && !!(status?.calendar.orgConnected || status?.calendar.workspaceConnected)}
                title="Calendar sync"
                okText={`Bookings sync to ${status?.calendar.syncProvider === "outlook_calendar" ? "Outlook" : "Google Calendar"}`}
                pendingText={
                  googleStatus.connected
                    ? "Google is connected — turn on booking sync in Appointments when you're ready"
                    : "Not set up — configure it later in Appointments"
                }
              />
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="button" className={PRIMARY_BTN} onClick={() => void finish()} disabled={finishBusy}>
                {finishBusy ? "Opening…" : "Go to my dashboard"}
              </button>
              <p className="text-xs text-white/40">You can finish anything you skipped from Settings → Connections.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusRow({ ok, title, okText, pendingText }: { ok: boolean; title: string; okText: string; pendingText: string }) {
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${ok ? "border-forge-lime/40 bg-forge-lime/5" : "border-amber-400/30 bg-amber-400/5"}`}>
      <span className={`mt-0.5 h-2.5 w-2.5 flex-none rounded-full ${ok ? "bg-forge-lime" : "bg-amber-400"}`} />
      <div>
        <p className="text-sm font-bold">{title}</p>
        <p className={`mt-0.5 text-xs ${ok ? "text-forge-lime" : "text-amber-200"}`}>{ok ? okText : pendingText}</p>
      </div>
    </div>
  );
}
