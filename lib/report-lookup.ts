import "server-only";
import { cache } from "react";
import { getPool } from "./db";
import type { VisibilityReport } from "./visibility-schema";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoredReport = {
  url: string;
  score: number;
  report: VisibilityReport;
  created_at: Date;
};

/**
 * Request-deduplicated report lookup shared by the share page, its
 * generateMetadata, and the dynamic OG image route. Invalid ids and DB
 * failures resolve to null (callers render fallbacks / 404).
 */
export const getVisibilityReport = cache(async (id: string): Promise<StoredReport | null> => {
  if (!UUID_RE.test(id)) return null;
  try {
    const { rows } = await getPool().query(
      "SELECT url, score, report, created_at FROM visibility_reports WHERE id = $1",
      [id],
    );
    return rows[0] ?? null;
  } catch (error) {
    console.error("Failed to load visibility report", error);
    return null;
  }
});

export function reportHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
