import "server-only";
import { getPool } from "@/lib/db";

export type CrawlOpportunityInput = {
  kind: "no_cta_page";
  title: string;
  evidence: Record<string, unknown>;
  actionHint: string;
  dedupKey: string;
  leadId: null;
};

const CTA_URL_PATTERNS = [
  /contact/i, /quote/i, /estimate/i, /book/i, /schedule/i,
  /appointment/i, /request/i, /call/i, /free-/i, /get-/i,
  /signup/i, /sign-up/i, /register/i, /consult/i,
];

const CTA_TITLE_PATTERNS = [
  /contact/i, /quote/i, /estimate/i, /book/i, /schedule/i,
  /appointment/i, /request/i, /call us/i, /get started/i, /free/i, /consult/i,
];

function likelyHasCTA(url: string, title: string | null): boolean {
  return (
    CTA_URL_PATTERNS.some((p) => p.test(url)) ||
    (title != null && CTA_TITLE_PATTERNS.some((p) => p.test(title)))
  );
}

/**
 * Returns successfully-crawled pages that show no sign of having a contact
 * form or CTA, based on URL and title heuristics. Reads the most recent
 * complete crawl per org to avoid stale results.
 */
export async function getCrawlSignals(organizationId: string): Promise<CrawlOpportunityInput[]> {
  const { rows: crawlRows } = await getPool().query(
    `SELECT id FROM org_site_crawls
     WHERE organization_id = $1 AND status = 'complete'
     ORDER BY finished_at DESC LIMIT 1`,
    [organizationId],
  );
  if (crawlRows.length === 0) return [];
  const crawlId = String(crawlRows[0].id);

  const { rows } = await getPool().query(
    `SELECT url, title FROM org_site_crawl_pages
     WHERE crawl_id = $1 AND ok = true AND title IS NOT NULL
     ORDER BY fetched_at ASC`,
    [crawlId],
  );

  return rows
    .filter((r) => !likelyHasCTA(String(r.url), r.title ? String(r.title) : null))
    .slice(0, 20)
    .map((r) => {
      const url = String(r.url);
      const pageTitle = r.title ? String(r.title) : url;
      return {
        kind: "no_cta_page" as const,
        title: `"${pageTitle}" has no visible contact form or call-to-action`,
        evidence: { url, pageTitle, crawlId },
        actionHint:
          "Add the Revenue Rescue widget or a booking link to this page to capture visitors as leads.",
        dedupKey: `crawl:${url.slice(0, 200)}`,
        leadId: null,
      };
    });
}
