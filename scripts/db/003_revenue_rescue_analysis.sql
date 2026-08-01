-- Revenue Rescue: AI lead scoring, analysis runs, and message drafts.
-- Idempotent — safe to run repeatedly. Apply with:
--   psql "$DATABASE_URL" -f scripts/db/003_revenue_rescue_analysis.sql

-- Analysis results live on the lead itself (checked constraints are enforced
-- in the application layer so this migration stays idempotent and additive).
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS analysis_status text NOT NULL DEFAULT 'pending';
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS score integer;
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS analysis jsonb;
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS analysis_error text;
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS analyzed_at timestamptz;

CREATE INDEX IF NOT EXISTS rescue_leads_org_score_idx ON rescue_leads (organization_id, score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS rescue_leads_org_category_idx ON rescue_leads (organization_id, category) WHERE category IS NOT NULL;
CREATE INDEX IF NOT EXISTS rescue_leads_org_analysis_status_idx ON rescue_leads (organization_id, analysis_status);

-- One row per batch analysis run (per org, optionally scoped to one import).
CREATE TABLE IF NOT EXISTS lead_analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  import_id uuid REFERENCES lead_imports(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'complete', 'partial', 'failed')),
  mode text NOT NULL DEFAULT 'hybrid' CHECK (mode IN ('hybrid', 'deterministic')),
  total_count integer NOT NULL DEFAULT 0,
  analyzed_count integer NOT NULL DEFAULT 0,
  ai_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_analysis_runs_org_idx ON lead_analysis_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_analysis_runs_import_idx ON lead_analysis_runs (import_id, created_at DESC);
-- Hard guarantee: at most ONE running analysis run per organization. Run
-- creation relies on this index (INSERT ... ON CONFLICT DO NOTHING), so two
-- concurrent starts can never both win — the database is the arbiter.
CREATE UNIQUE INDEX IF NOT EXISTS lead_analysis_runs_one_active_idx ON lead_analysis_runs (organization_id) WHERE status = 'running';

-- Generated message drafts (never sent from here — the campaigns module owns
-- approval and sending). Content shape depends on message_type.
CREATE TABLE IF NOT EXISTS lead_message_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES rescue_leads(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  message_type text NOT NULL CHECK (message_type IN ('sms', 'email', 'call_script', 'voicemail', 'follow_up_note', 'sequence')),
  tone text NOT NULL DEFAULT 'professional',
  objective text,
  mode text NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'template')),
  content jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_message_drafts_lead_idx ON lead_message_drafts (organization_id, lead_id, created_at DESC);
