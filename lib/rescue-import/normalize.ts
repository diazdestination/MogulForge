/**
 * Value cleaning + normalization for imported lead rows.
 * Pure module — no server-only imports, directly unit-testable.
 */

export function cleanText(value: unknown, maxLength = 500): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Lowercased, trimmed email — or null when it is not a plausible address. */
export function normalizeEmail(value: unknown): string | null {
  const text = cleanText(value, 320)?.toLowerCase() ?? null;
  if (!text || !EMAIL_RE.test(text)) return null;
  return text;
}

/**
 * Normalizes US/Canada phone numbers to E.164 (+1XXXXXXXXXX).
 * Accepts 10-digit or 11-digit-with-leading-1 inputs; anything else is null.
 */
export function normalizePhone(value: unknown): string | null {
  const text = cleanText(value, 40);
  if (!text) return null;
  const digits = text.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Parses common date shapes (ISO, US m/d/y, Excel serial numbers) to YYYY-MM-DD.
 * Returns null when unparseable rather than guessing.
 */
export function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial date (days since 1899-12-30); accept plausible range only.
    if (value > 20000 && value < 80000) {
      const ms = Math.round((value - 25569) * 86400 * 1000);
      return new Date(ms).toISOString().slice(0, 10);
    }
    return null;
  }
  const text = String(value).trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    return buildDate(Number(y), Number(m), Number(d));
  }
  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (us) {
    const [, m, d, yRaw] = us;
    const y = yRaw.length === 2 ? Number(yRaw) + 2000 : Number(yRaw);
    return buildDate(y, Number(m), Number(d));
  }
  return null;
}

function buildDate(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Parses money-ish values ("$18,500.00", "18500") to a number, or null. */
export function normalizeMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
  const text = String(value).replace(/[$,\s]/g, "");
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100_000_000) return null;
  return Math.round(parsed * 100) / 100;
}

export type ConsentStatus = "unknown" | "express" | "implied" | "opted_out";

const OPT_OUT_VALUES = new Set([
  "optedout", "optout", "no", "false", "0", "unsubscribed", "unsubscribe", "dnc",
  "donotcontact", "donotcall", "donottext", "stop", "declined", "revoked",
]);
const EXPRESS_VALUES = new Set([
  "express", "yes", "true", "1", "optedin", "optin", "subscribed", "consented", "granted",
]);
const IMPLIED_VALUES = new Set(["implied", "implicit", "existingcustomer", "inquiry"]);

/** Maps free-form consent column values to a canonical consent status. */
export function normalizeConsent(value: unknown): ConsentStatus {
  const text = cleanText(value, 80)?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  if (!text) return "unknown";
  if (OPT_OUT_VALUES.has(text)) return "opted_out";
  if (EXPRESS_VALUES.has(text)) return "express";
  if (IMPLIED_VALUES.has(text)) return "implied";
  return "unknown";
}
