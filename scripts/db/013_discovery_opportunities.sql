-- Discovery opportunities and closer briefings (idempotent)

CREATE TABLE IF NOT EXISTS org_discovery_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status           text        NOT NULL DEFAULT 'running'
                               CHECK (status IN ('running','complete','failed')),
  error            text,
  opportunities_found  integer NOT NULL DEFAULT 0,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX IF NOT EXISTS org_discovery_runs_org_idx
  ON org_discovery_runs (organization_id, started_at DESC);

-- One opportunity row per (org, kind, dedup_key).
-- A partial unique index on status='new' prevents duplicate open items across
-- runs; dismissed/actioned ones are kept for history.
CREATE TABLE IF NOT EXISTS org_opportunities (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id           uuid        REFERENCES org_discovery_runs(id) ON DELETE SET NULL,
  kind             text        NOT NULL
                               CHECK (kind IN (
                                 'stale_estimate','hot_uncontacted',
                                 'no_cta_page','query_spike','gbp_review'
                               )),
  title            text        NOT NULL,
  evidence         jsonb       NOT NULL DEFAULT '{}',
  action_hint      text        NOT NULL DEFAULT '',
  status           text        NOT NULL DEFAULT 'new'
                               CHECK (status IN ('new','actioned','dismissed')),
  dedup_key        text        NOT NULL,
  lead_id          uuid        REFERENCES rescue_leads(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_opportunities_org_status_idx
  ON org_opportunities (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS org_opportunities_lead_idx
  ON org_opportunities (lead_id) WHERE lead_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'org_opportunities'
      AND indexname = 'org_opportunities_dedup_new_idx'
  ) THEN
    CREATE UNIQUE INDEX org_opportunities_dedup_new_idx
      ON org_opportunities (organization_id, kind, dedup_key)
      WHERE status = 'new';
  END IF;
END $$;

-- AI-generated closer briefings, one cached row per lead
CREATE TABLE IF NOT EXISTS lead_closer_briefings (
  lead_id          uuid        PRIMARY KEY REFERENCES rescue_leads(id) ON DELETE CASCADE,
  organization_id  uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  briefing_text    text,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  error            text
);
CREATE INDEX IF NOT EXISTS lead_closer_briefings_org_idx
  ON lead_closer_briefings (organization_id);
