/**
 * Report date-range helpers. Pure module — no server-only imports, directly
 * unit-testable. Ranges are YYYY-MM-DD calendar dates, inclusive both ends;
 * null means unbounded on that side.
 */

export type ReportRange = { from: string | null; to: string | null };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a YYYY-MM-DD query param; anything else means "unbounded". */
export function parseReportDate(value: string | null | undefined): string | null {
  if (!value || !DATE_RE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return value;
}

export function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export type RangePreset = { key: string; label: string; from: string | null; to: string | null };

/** Named presets for the range picker, computed against local "today". */
export function buildRangePresets(now: Date = new Date()): RangePreset[] {
  const today = isoDay(now);
  const daysAgo = (n: number) => {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - n);
    return isoDay(d);
  };
  return [
    { key: "7d", label: "Last 7 days", from: daysAgo(6), to: today },
    { key: "30d", label: "Last 30 days", from: daysAgo(29), to: today },
    { key: "90d", label: "Last 90 days", from: daysAgo(89), to: today },
    { key: "12m", label: "Last 12 months", from: daysAgo(364), to: today },
    { key: "all", label: "All time", from: null, to: null },
  ];
}

/** Query-string suffix for a range ("" when unbounded on both sides). */
export function rangeQuery(range: ReportRange): string {
  const parts: string[] = [];
  if (range.from) parts.push(`from=${range.from}`);
  if (range.to) parts.push(`to=${range.to}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}
