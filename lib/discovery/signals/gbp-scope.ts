/**
 * Pure utility for parsing the `granted_scopes` column value.
 * The DB stores scopes as a space-delimited text field.
 * Kept in its own file so tests can import it without pulling in server-only deps.
 */

export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

/**
 * Parses the `granted_scopes` column value into an array of scope strings.
 * Handles null, empty, and (defensively) legacy array values without throwing.
 */
export function parseGrantedScopes(raw: unknown): string[] {
  if (typeof raw === "string" && raw.trim() !== "") return raw.trim().split(/\s+/);
  if (Array.isArray(raw)) return (raw as unknown[]).map(String);
  return [];
}
