"use client";
import { LEAD_FIELDS } from "@/lib/rescue-import/fields";
import type { ColumnMapping } from "@/lib/rescue-import/mapping";

export type MappingState = Record<string, string | null>;

function confidenceBadge(confidence: number, overridden: boolean) {
  if (overridden) return { label: "Manual", cls: "border-white/25 text-white/70" };
  if (confidence >= 0.9) return { label: "High match", cls: "border-forge-lime/50 text-forge-lime" };
  if (confidence >= 0.55) return { label: "Likely match", cls: "border-yellow-400/50 text-yellow-300" };
  return { label: "No match", cls: "border-forge-rust/50 text-forge-rust" };
}

/**
 * Field-mapping editor: one row per uploaded column with its sample value, the
 * auto-matched target (with confidence), and a manual override select.
 */
export function RescueMappingTable({
  autoMapping,
  mapping,
  onChange,
}: {
  autoMapping: ColumnMapping[];
  mapping: MappingState;
  onChange: (next: MappingState) => void;
}) {
  const usedTargets = new Set(Object.values(mapping).filter(Boolean));
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-white/[.04] text-xs uppercase tracking-wider text-white/45">
          <tr>
            <th className="px-4 py-3 font-bold">Your column</th>
            <th className="px-4 py-3 font-bold">Sample value</th>
            <th className="px-4 py-3 font-bold">Imports as</th>
            <th className="px-4 py-3 font-bold">Match</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {autoMapping.map((column) => {
            const current = mapping[column.sourceColumn] ?? null;
            const overridden = current !== (column.target ?? null);
            const badge = current ? confidenceBadge(column.confidence, overridden) : { label: "Skipped", cls: "border-white/15 text-white/35" };
            return (
              <tr key={column.sourceColumn}>
                <td className="px-4 py-3 font-semibold">{column.sourceColumn}</td>
                <td className="max-w-[220px] truncate px-4 py-3 text-white/50">{column.sample || <span className="text-white/25">—</span>}</td>
                <td className="px-4 py-3">
                  <select
                    value={current ?? ""}
                    onChange={(event) => onChange({ ...mapping, [column.sourceColumn]: event.target.value || null })}
                    className="w-full rounded-lg border border-white/15 bg-forge-ink px-3 py-2 text-sm outline-none focus:border-forge-lime"
                  >
                    <option value="">Don&rsquo;t import</option>
                    {LEAD_FIELDS.map((field) => (
                      <option key={field.key} value={field.key} disabled={usedTargets.has(field.key) && current !== field.key}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${badge.cls}`}>{badge.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
