-- Revenue Rescue: intake wizard + lead import pipeline.
-- Idempotent — safe to run repeatedly. Apply with:
--   psql "$DATABASE_URL" -f scripts/db/002_revenue_rescue_imports.sql

-- Intake wizard submissions (one per organization onboarding pass).
CREATE TABLE IF NOT EXISTS rescue_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  company jsonb NOT NULL DEFAULT '{}'::jsonb,
  lead_sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  campaign_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmations jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rescue_intakes_org_idx ON rescue_intakes (organization_id, created_at DESC);

-- One row per uploaded lead file. The raw file bytes live in file_data (bytea) —
-- private by construction: only served through authenticated, org-scoped API routes.
CREATE TABLE IF NOT EXISTS lead_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  file_type text NOT NULL CHECK (file_type IN ('csv', 'xlsx', 'xls', 'json')),
  file_size integer NOT NULL,
  file_data bytea NOT NULL,
  source_label text,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN (
    'uploaded', 'validating', 'mapping_required', 'cleaning', 'deduplicating',
    'suppression_checking', 'importing', 'complete', 'failed', 'partial'
  )),
  row_count integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  suppressed_count integer NOT NULL DEFAULT 0,
  invalid_count integer NOT NULL DEFAULT 0,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample_rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  auto_mapping jsonb NOT NULL DEFAULT '[]'::jsonb,
  field_mapping jsonb,
  stage_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_imports_org_idx ON lead_imports (organization_id, created_at DESC);

-- Tenant-scoped lead records produced by the import pipeline.
CREATE TABLE IF NOT EXISTS rescue_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  import_id uuid REFERENCES lead_imports(id) ON DELETE SET NULL,
  first_name text,
  last_name text,
  email text,
  email_normalized text,
  phone text,
  phone_normalized text,
  address text,
  city text,
  state text,
  zip text,
  project_type text,
  project_description text,
  estimated_value numeric(12, 2),
  source text,
  source_detail text,
  external_record_id text,
  first_contact_date date,
  last_contact_date date,
  estimate_date date,
  consent_status text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown', 'express', 'implied', 'opted_out')),
  suppressed boolean NOT NULL DEFAULT false,
  suppression_reason text,
  status text NOT NULL DEFAULT 'imported',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rescue_leads_org_idx ON rescue_leads (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rescue_leads_org_email_idx ON rescue_leads (organization_id, email_normalized) WHERE email_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS rescue_leads_org_phone_idx ON rescue_leads (organization_id, phone_normalized) WHERE phone_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS rescue_leads_org_external_idx ON rescue_leads (organization_id, external_record_id) WHERE external_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rescue_leads_import_idx ON rescue_leads (import_id);

-- Do-not-contact list per organization. Checked on every import; opt-outs found
-- in imported files are added here immediately.
CREATE TABLE IF NOT EXISTS suppression_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'phone')),
  value text NOT NULL,
  reason text NOT NULL,
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, channel, value)
);
CREATE INDEX IF NOT EXISTS suppression_records_org_idx ON suppression_records (organization_id);

-- Rows the pipeline could not import (invalid or duplicate), kept for the
-- rejected-row CSV export.
CREATE TABLE IF NOT EXISTS import_rejected_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES lead_imports(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  row_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_rejected_rows_import_idx ON import_rejected_rows (import_id, row_number);
