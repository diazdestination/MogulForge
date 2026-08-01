"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FileSpreadsheet, RefreshCw, UploadCloud, X } from "lucide-react";
import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES, fileExtension, isAcceptedExtension } from "@/lib/rescue-import/fields";
import { IMPORT_STATUS_LABELS, isProcessingStatus, statusProgress } from "@/lib/rescue-import/status";
import type { ColumnMapping } from "@/lib/rescue-import/mapping";
import { RescueMappingTable, type MappingState } from "./rescue-mapping-table";

type ImportRecord = {
  id: string;
  fileName: string;
  fileType: string;
  sourceLabel: string | null;
  status: string;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  suppressedCount: number;
  invalidCount: number;
  columns: string[];
  autoMapping: ColumnMapping[];
  fieldMapping: Record<string, string | null> | null;
  stageLog: { stage: string; at: string; detail?: string }[];
  error: string | null;
  createdAt: string;
};

function statusBadge(status: string) {
  if (status === "complete") return "border-forge-lime/50 text-forge-lime";
  if (status === "failed") return "border-forge-rust/60 text-forge-rust";
  if (status === "partial") return "border-yellow-400/50 text-yellow-300";
  if (status === "mapping_required") return "border-yellow-400/50 text-yellow-300";
  return "border-white/25 text-white/70";
}

export function RescueImportsPanel({
  orgId,
  initialImports,
  canWrite,
  highlightId,
}: {
  orgId: string;
  initialImports: ImportRecord[];
  canWrite: boolean;
  highlightId: string | null;
}) {
  const [imports, setImports] = useState<ImportRecord[]>(initialImports);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [mappingFor, setMappingFor] = useState<ImportRecord | null>(null);
  const [mapping, setMapping] = useState<MappingState>({});
  const [savingMapping, setSavingMapping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/orgs/${orgId}/imports`, { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      setImports(body.imports);
    } catch {
      /* transient — keep last known state */
    }
  }, [orgId]);

  const anyProcessing = imports.some((record) => isProcessingStatus(record.status));
  useEffect(() => {
    if (!anyProcessing) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [anyProcessing, refresh]);

  async function handleUpload(file: File) {
    setError("");
    const ext = fileExtension(file.name);
    if (!isAcceptedExtension(ext)) {
      setError("Unsupported file type. Upload a .csv, .xlsx, .xls, or .json file.");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/orgs/${orgId}/imports`, { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Upload failed.");
        return;
      }
      const record: ImportRecord = body.import;
      setImports((prev) => [record, ...prev]);
      setMappingFor(record);
      setMapping(Object.fromEntries(record.autoMapping.map((c) => [c.sourceColumn, c.target])));
    } catch {
      setError("Upload failed. Check your connection and try again.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function confirmMapping() {
    if (!mappingFor) return;
    setSavingMapping(true);
    setError("");
    try {
      const res = await fetch(`/api/orgs/${orgId}/imports/${mappingFor.id}/mapping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Could not save the mapping.");
        return;
      }
      setMappingFor(null);
      await refresh();
    } catch {
      setError("Could not save the mapping. Try again.");
    } finally {
      setSavingMapping(false);
    }
  }

  async function retry(importId: string) {
    setError("");
    const res = await fetch(`/api/orgs/${orgId}/imports/${importId}/retry`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error ?? "Retry failed.");
      return;
    }
    await refresh();
  }

  function openMapping(record: ImportRecord) {
    setMappingFor(record);
    setMapping(
      record.fieldMapping ?? Object.fromEntries(record.autoMapping.map((c) => [c.sourceColumn, c.target])),
    );
  }

  const mappedTargets = new Set(Object.values(mapping).filter(Boolean));
  const hasContactField = mappedTargets.has("email") || mappedTargets.has("phone");

  return (
    <div className="space-y-8">
      {canWrite && !mappingFor && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); const dropped = e.dataTransfer.files?.[0]; if (dropped) void handleUpload(dropped); }}
          onClick={() => fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${dragOver ? "border-forge-lime bg-forge-lime/[.06]" : "border-white/20 bg-white/[.02] hover:border-white/40"}`}
        >
          <UploadCloud className="text-forge-lime" size={30} />
          <p className="text-sm font-bold">{uploading ? "Uploading…" : "Import a new lead file — drag & drop or click to browse"}</p>
          <p className="text-xs text-white/40">.{ACCEPTED_EXTENSIONS.join("  ·  .")} — up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB · <a href="/api/revenue-rescue/template" onClick={(e) => e.stopPropagation()} className="font-bold text-forge-lime hover:underline">sample template</a></p>
        </div>
      )}
      <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls,.json" className="hidden" onChange={(e) => { const selected = e.target.files?.[0]; if (selected) void handleUpload(selected); }} />

      {mappingFor && (
        <div className="rounded-2xl border border-yellow-400/30 bg-yellow-400/[.04] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <FileSpreadsheet className="text-forge-lime" size={22} />
              <div>
                <p className="font-extrabold">{mappingFor.fileName}</p>
                <p className="text-xs text-white/50">{mappingFor.rowCount.toLocaleString()} rows — match your columns, then start the import</p>
              </div>
            </div>
            <button type="button" onClick={() => setMappingFor(null)} className="inline-flex items-center gap-1 rounded-full border border-white/20 px-3 py-1.5 text-xs font-bold text-white/60 hover:border-white/50"><X size={13} /> Close</button>
          </div>
          <div className="mt-5"><RescueMappingTable autoMapping={mappingFor.autoMapping} mapping={mapping} onChange={setMapping} /></div>
          {!hasContactField && <p className="mt-4 text-sm font-bold text-forge-rust">Map at least one contact column — email or phone.</p>}
          <button type="button" onClick={() => void confirmMapping()} disabled={savingMapping || !hasContactField} className="btn-primary mt-5 disabled:opacity-40">
            {savingMapping ? "Starting import…" : "Start the import"}
          </button>
        </div>
      )}

      {error && <p role="alert" className="rounded-xl border border-forge-rust/30 bg-forge-rust/10 p-4 text-sm text-forge-rust">{error}</p>}

      {imports.length === 0 ? (
        <p className="rounded-2xl border border-white/10 bg-white/[.03] p-8 text-center text-sm text-white/50">No imports yet. Upload your first lead file to build your database.</p>
      ) : (
        <div className="space-y-4">
          {imports.map((record) => {
            const processing = isProcessingStatus(record.status);
            const latest = record.stageLog[record.stageLog.length - 1];
            return (
              <article key={record.id} className={`rounded-2xl border p-6 ${record.id === highlightId ? "border-forge-lime/50 bg-forge-lime/[.04]" : "border-white/10 bg-white/[.03]"}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <FileSpreadsheet size={20} className="text-white/40" />
                    <div>
                      <p className="font-extrabold">{record.fileName}</p>
                      <p className="text-xs text-white/45">{new Date(record.createdAt).toLocaleString()} · {record.rowCount.toLocaleString()} rows{record.sourceLabel ? ` · ${record.sourceLabel}` : ""}</p>
                    </div>
                  </div>
                  <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-extrabold uppercase tracking-wider ${statusBadge(record.status)}`}>
                    {processing && <span className="h-2 w-2 animate-pulse rounded-full bg-current" />}
                    {IMPORT_STATUS_LABELS[record.status] ?? record.status}
                  </span>
                </div>

                <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className={`h-full rounded-full transition-all ${record.status === "failed" ? "bg-forge-rust" : record.status === "partial" ? "bg-yellow-400" : "bg-forge-lime"}`}
                    style={{ width: `${statusProgress(record.status)}%` }}
                  />
                </div>
                {latest?.detail && <p className="mt-2 text-xs text-white/45">{latest.detail}</p>}
                {record.error && <p className="mt-2 text-sm font-semibold text-forge-rust">{record.error}</p>}

                <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                  <span><span className="font-display text-xl font-semibold text-forge-lime">{record.importedCount.toLocaleString()}</span> <span className="text-white/45">imported</span></span>
                  <span><span className="font-display text-xl font-semibold">{record.duplicateCount.toLocaleString()}</span> <span className="text-white/45">duplicates</span></span>
                  <span><span className="font-display text-xl font-semibold">{record.suppressedCount.toLocaleString()}</span> <span className="text-white/45">suppressed</span></span>
                  <span><span className="font-display text-xl font-semibold">{record.invalidCount.toLocaleString()}</span> <span className="text-white/45">invalid</span></span>
                </div>

                <div className="mt-4 flex flex-wrap gap-3 border-t border-white/10 pt-4 text-sm">
                  {canWrite && record.status === "mapping_required" && (
                    <button type="button" onClick={() => openMapping(record)} className="inline-flex items-center gap-2 font-bold text-forge-lime hover:underline">Finish column mapping</button>
                  )}
                  {canWrite && (record.status === "failed" || record.status === "partial") && (
                    <button type="button" onClick={() => void retry(record.id)} className="inline-flex items-center gap-2 font-bold text-white/70 hover:text-white"><RefreshCw size={14} /> Retry import</button>
                  )}
                  {(record.invalidCount > 0 || record.duplicateCount > 0) && (
                    <a href={`/api/orgs/${orgId}/imports/${record.id}/rejected`} className="inline-flex items-center gap-2 font-bold text-white/70 hover:text-white"><Download size={14} /> Rejected rows (CSV)</a>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
