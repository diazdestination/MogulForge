-- Guided onboarding progress per organization, plus granted-scope tracking on
-- per-org calendar OAuth connections (groundwork for incremental Google scopes).
-- Idempotent — safe to run repeatedly:
--   psql "$DATABASE_URL" -f scripts/db/011_org_onboarding.sql

-- One row per org that has entered the guided onboarding flow. `steps` records
-- only the user's explicit choices ({"google":"done"|"skipped", ...}) — the
-- status screen always recomputes live connection state and never trusts these
-- flags as proof a connection works.
CREATE TABLE IF NOT EXISTS org_onboarding (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Which scopes the provider actually granted at consent time. Later features
-- (Gmail sending, analytics) can request incremental scopes and check what an
-- org already has instead of forcing a full re-consent.
ALTER TABLE org_calendar_connections
  ADD COLUMN IF NOT EXISTS granted_scopes text;
