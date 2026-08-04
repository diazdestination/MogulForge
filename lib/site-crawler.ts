import "server-only";
import { getPool } from "./db";
import { assertPublicHost, fetchWithLimits } from "./visibility-crawler";
import { extractHtmlSignals, extractInternalLinks, extractSitemapLocs } from "./visibility-crawler-parse";

/**
 * Whole-site access check: a polite, bounded crawl of the client's website
 * (sitemap first, then internal links) that proves per-page whether we can
 * actually reach their content. Same SSRF rules as the single-page visibility
 * crawler (public hosts only, redirect + byte limits), plus a page cap and a
 * fixed delay between requests so we never hammer a client's site.
 *
 * Crawls run in-process in the background (same pattern as CRM pushes). On
 * autoscale a redeploy mid-crawl can strand a "running" row, so anything
 * running longer than CRAWL_TIMEOUT_MINUTES is treated as failed.
 */

export const DEFAULT_PAGE_CAP = 30;
export const MAX_PAGE_CAP = 50;
const DELAY_MS = 400;
/**
 * Hard wall-clock budget for the crawl worker itself. Worst case is
 * MAX_PAGE_CAP pages × (12s fetch timeout + delay) ≈ 10.5 min, so 12 min
 * covers it; the worker stops early and completes honestly if it's hit.
 */
const CRAWL_DEADLINE_MS = 12 * 60 * 1000;
/**
 * Stale-detection window: strictly longer than the worker deadline, so a
 * crawl can only be auto-failed after its worker has provably stopped
 * (finished, crashed, or the process was redeployed).
 */
const CRAWL_TIMEOUT_MINUTES = 15;

export type SiteCrawl = {
  id: string;
  rootUrl: string;
  status: "running" | "complete" | "failed";
  error: string | null;
  pageCap: number;
  pagesFound: number;
  pagesOk: number;
  usedSitemap: boolean;
  startedAt: string;
  finishedAt: string | null;
};

export type SiteCrawlPage = {
  url: string;
  ok: boolean;
  httpStatus: number | null;
  title: string | null;
  error: string | null;
  discoveredVia: "root" | "sitemap" | "link";
};

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function mapCrawl(r: Record<string, unknown>): SiteCrawl {
  return {
    id: r.id as string,
    rootUrl: r.root_url as string,
    status: r.status as SiteCrawl["status"],
    error: (r.error as string | null) ?? null,
    pageCap: Number(r.page_cap),
    pagesFound: Number(r.pages_found),
    pagesOk: Number(r.pages_ok),
    usedSitemap: Boolean(r.used_sitemap),
    startedAt: toIso(r.started_at),
    finishedAt: r.finished_at ? toIso(r.finished_at) : null,
  };
}

/** Latest crawl for an org (stale "running" rows are surfaced as failed). */
export async function getLatestSiteCrawl(organizationId: string): Promise<{ crawl: SiteCrawl; pages: SiteCrawlPage[] } | null> {
  await getPool().query(
    `UPDATE org_site_crawls SET status = 'failed', error = 'The check was interrupted (server restarted). Run it again.', finished_at = now()
     WHERE organization_id = $1 AND status = 'running' AND started_at < now() - interval '${CRAWL_TIMEOUT_MINUTES} minutes'`,
    [organizationId],
  );
  const { rows } = await getPool().query(
    "SELECT * FROM org_site_crawls WHERE organization_id = $1 ORDER BY started_at DESC LIMIT 1",
    [organizationId],
  );
  if (!rows[0]) return null;
  const crawl = mapCrawl(rows[0]);
  const pages = await getPool().query(
    "SELECT url, ok, http_status, title, error, discovered_via FROM org_site_crawl_pages WHERE crawl_id = $1 ORDER BY fetched_at ASC",
    [crawl.id],
  );
  return {
    crawl,
    pages: pages.rows.map((p) => ({
      url: p.url,
      ok: p.ok,
      httpStatus: p.http_status,
      title: p.title,
      error: p.error,
      discoveredVia: p.discovered_via,
    })),
  };
}

export async function hasRunningCrawl(organizationId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 FROM org_site_crawls WHERE organization_id = $1 AND status = 'running'
     AND started_at >= now() - interval '${CRAWL_TIMEOUT_MINUTES} minutes' LIMIT 1`,
    [organizationId],
  );
  return rows.length > 0;
}

/**
 * Creates the crawl row and starts the crawl in the background. Returns the
 * crawl id immediately; callers poll getLatestSiteCrawl for progress.
 */
export async function startSiteCrawl(input: {
  organizationId: string;
  rootUrl: string;
  createdBy: string;
  pageCap?: number;
}): Promise<{ crawlId: string } | { error: string }> {
  let root: URL;
  try {
    root = new URL(input.rootUrl.includes("://") ? input.rootUrl : `https://${input.rootUrl}`);
  } catch {
    return { error: "That website address doesn't look valid." };
  }
  const hostError = await assertPublicHost(root);
  if (hostError) return { error: hostError };

  const cap = Math.min(Math.max(input.pageCap ?? DEFAULT_PAGE_CAP, 5), MAX_PAGE_CAP);

  // Atomic claim: a per-org transaction-scoped advisory lock serializes
  // concurrent starts across app instances, and the running-crawl check +
  // insert happen inside that lock, so two servers can never both start.
  const client = await getPool().connect();
  let crawlId: string;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('site-crawl:' || $1::text, 0))", [input.organizationId]);
    const running = await client.query(
      `SELECT 1 FROM org_site_crawls WHERE organization_id = $1 AND status = 'running'
       AND started_at >= now() - interval '${CRAWL_TIMEOUT_MINUTES} minutes' LIMIT 1`,
      [input.organizationId],
    );
    if (running.rows.length > 0) {
      await client.query("ROLLBACK");
      return { error: "A site check is already running. Wait for it to finish." };
    }
    const { rows } = await client.query(
      `INSERT INTO org_site_crawls (organization_id, root_url, page_cap, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.organizationId, root.href, cap, input.createdBy],
    );
    crawlId = rows[0].id as string;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  void runCrawl(crawlId, root, cap).catch(async (error) => {
    console.error(`Site crawl ${crawlId} crashed`, error);
    await getPool()
      .query(
        `UPDATE org_site_crawls SET status = 'failed', error = 'The check hit an unexpected error. Run it again.', finished_at = now()
         WHERE id = $1 AND status = 'running'`,
        [crawlId],
      )
      .catch(() => {});
  });
  return { crawlId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recordPage(crawlId: string, page: SiteCrawlPage): Promise<void> {
  await getPool().query(
    `INSERT INTO org_site_crawl_pages (crawl_id, url, ok, http_status, title, error, discovered_via)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [crawlId, page.url.slice(0, 2000), page.ok, page.httpStatus, page.title, page.error, page.discoveredVia],
  );
}

async function runCrawl(crawlId: string, root: URL, cap: number): Promise<void> {
  // Discover sitemap URLs first — they represent the pages the site WANTS seen.
  const sitemapRes = await fetchWithLimits(`${root.origin}/sitemap.xml`, "application/xml");
  const sitemapUrls =
    sitemapRes && sitemapRes.status === 200
      ? extractSitemapLocs(sitemapRes.text)
          .filter((u) => {
            try {
              return new URL(u).origin === root.origin;
            } catch {
              return false;
            }
          })
          // A sitemapindex points at more sitemaps, not pages — skip those.
          .filter((u) => !/sitemap[^/]*\.xml$/i.test(new URL(u).pathname))
      : [];
  const usedSitemap = sitemapUrls.length > 0;

  const queue: { url: string; via: SiteCrawlPage["discoveredVia"] }[] = [
    { url: root.href, via: "root" },
    ...sitemapUrls.map((u) => ({ url: u, via: "sitemap" as const })),
  ];
  const seen = new Set<string>();
  let fetched = 0;
  let okCount = 0;
  const deadline = Date.now() + CRAWL_DEADLINE_MS;

  while (queue.length > 0 && fetched < cap && Date.now() < deadline) {
    const next = queue.shift()!;
    const normalized = next.url.replace(/#.*$/, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const page = await fetchWithLimits(normalized);
    fetched++;
    if (!page) {
      await recordPage(crawlId, {
        url: normalized,
        ok: false,
        httpStatus: null,
        title: null,
        error: "No response (timeout, blocked, or unreachable).",
        discoveredVia: next.via,
      });
    } else {
      const ok = page.status >= 200 && page.status < 400;
      const title = ok ? extractHtmlSignals(page.text).title : null;
      await recordPage(crawlId, {
        url: normalized,
        ok,
        httpStatus: page.status,
        title,
        error: ok ? null : `The page responded with HTTP ${page.status}.`,
        discoveredVia: next.via,
      });
      if (ok) okCount++;
      // Only follow links when the sitemap gave us nothing (link discovery is
      // the fallback) or the queue would otherwise run dry before the cap.
      if (ok && queue.length < cap * 2) {
        for (const link of extractInternalLinks(page.text, page.finalUrl, cap * 2)) {
          if (!seen.has(link.replace(/#.*$/, ""))) queue.push({ url: link, via: "link" });
        }
      }
    }
    // Progress and finalization only apply while the row is still 'running' —
    // if stale-recovery failed this crawl (redeploy race), never overwrite it.
    await getPool().query("UPDATE org_site_crawls SET pages_found = $2, pages_ok = $3 WHERE id = $1 AND status = 'running'", [crawlId, fetched, okCount]);
    if (queue.length > 0 && fetched < cap) await sleep(DELAY_MS);
  }

  await getPool().query(
    `UPDATE org_site_crawls SET status = 'complete', pages_found = $2, pages_ok = $3, used_sitemap = $4, finished_at = now()
     WHERE id = $1 AND status = 'running'`,
    [crawlId, fetched, okCount, usedSitemap],
  );
}
