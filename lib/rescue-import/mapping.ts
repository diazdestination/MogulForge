/**
 * Auto-matching of uploaded column headers to canonical lead fields, with
 * confidence scores and value-pattern hints.
 * Pure module — no server-only imports, directly unit-testable.
 */
import { LEAD_FIELDS, type LeadFieldKey } from "./fields.ts";

export type ColumnMapping = {
  /** Header exactly as it appears in the uploaded file. */
  sourceColumn: string;
  /** Auto-matched target field, or null when nothing plausible was found. */
  target: LeadFieldKey | null;
  /** 0–1 confidence in the auto-match. */
  confidence: number;
  /** First non-empty sample value for the column (for the mapping UI). */
  sample: string;
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const EMAIL_SAMPLE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_SAMPLE_RE = /^[\s()+.\-\d]{7,20}$/;

/**
 * Proposes a mapping for every uploaded column. Exact alias matches score high,
 * partial header matches medium, value-pattern hints (email/phone-looking
 * samples) lower. Each target field is claimed by at most one column — the
 * highest-scoring one wins.
 */
export function autoMapColumns(headers: string[], rows: string[][]): ColumnMapping[] {
  const samples = headers.map((_, colIdx) => {
    for (const row of rows) {
      const value = (row[colIdx] ?? "").toString().trim();
      if (value) return value.slice(0, 120);
    }
    return "";
  });

  type Candidate = { colIdx: number; target: LeadFieldKey; confidence: number };
  const candidates: Candidate[] = [];

  headers.forEach((header, colIdx) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return;
    let best: Candidate | null = null;
    for (const field of LEAD_FIELDS) {
      let confidence = 0;
      if (field.aliases.includes(normalized) || normalizeHeader(field.templateHeader) === normalized || normalizeHeader(field.label) === normalized) {
        confidence = 0.95;
      } else if (field.aliases.some((alias) => alias.length >= 4 && (normalized.includes(alias) || alias.includes(normalized)))) {
        confidence = 0.7;
      }
      if (confidence > (best?.confidence ?? 0)) best = { colIdx, target: field.key, confidence };
    }
    // Value-pattern hints when the header told us nothing.
    if (!best && samples[colIdx]) {
      if (EMAIL_SAMPLE_RE.test(samples[colIdx])) best = { colIdx, target: "email", confidence: 0.55 };
      else if (PHONE_SAMPLE_RE.test(samples[colIdx]) && samples[colIdx].replace(/\D/g, "").length >= 10) {
        best = { colIdx, target: "phone", confidence: 0.55 };
      }
    }
    if (best) candidates.push(best);
  });

  // Each target field can only be claimed once; highest confidence wins.
  candidates.sort((a, b) => b.confidence - a.confidence);
  const claimedTargets = new Set<LeadFieldKey>();
  const byColumn = new Map<number, Candidate>();
  for (const candidate of candidates) {
    if (claimedTargets.has(candidate.target)) continue;
    claimedTargets.add(candidate.target);
    byColumn.set(candidate.colIdx, candidate);
  }

  return headers.map((header, colIdx) => {
    const match = byColumn.get(colIdx);
    return {
      sourceColumn: header,
      target: match?.target ?? null,
      confidence: match ? Math.round(match.confidence * 100) / 100 : 0,
      sample: samples[colIdx],
    };
  });
}

/** A usable mapping must include at least one contact field (email or phone). */
export function mappingHasContactField(mapping: Record<string, LeadFieldKey | null | undefined>): boolean {
  const targets = new Set(Object.values(mapping).filter(Boolean));
  return targets.has("email") || targets.has("phone");
}
