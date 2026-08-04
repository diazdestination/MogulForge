-- Site health: whole-site access crawls, widget liveness heartbeats, and
-- Google Search Console / GA4 analytics snapshots. Idempotent — post-merge
-- runs every script in order on every merge.

CREATE TABLE IF NOT EXISTS org_site_crawls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  root_url text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'failed')),
  error text,
  page_cap integer NOT NULL DEFAULT 30,
  pages_found integer NOT NULL DEFAULT 0,
  pages_ok integer NOT NULL DEFAULT 0,
  used_sitemap boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS org_site_crawls_org_idx ON org_site_crawls(organization_id, started_at DESC);

CREATE TABLE IF NOT EXISTS org_site_crawl_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_id uuid NOT NULL REFERENCES org_site_crawls(id) ON DELETE CASCADE,
  url text NOT NULL,
  ok boolean NOT NULL,
  http_status integer,
  title text,
  error text,
  discovered_via text NOT NULL DEFAULT 'link' CHECK (discovered_via IN ('root', 'sitemap', 'link')),
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_site_crawl_pages_crawl_idx ON org_site_crawl_pages(crawl_id);

-- One row per (org, origin, module) the embed loader has ever pinged from.
CREATE TABLE IF NOT EXISTS org_widget_heartbeats (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  origin text NOT NULL,
  module text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  beat_count bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, origin, module)
);

-- Latest snapshot per source; errors are stored honestly instead of stale "ok" data.
CREATE TABLE IF NOT EXISTS org_analytics_snapshots (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('search_console', 'ga4')),
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  error text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, source)
);
