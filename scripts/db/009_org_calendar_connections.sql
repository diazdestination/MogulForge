-- Per-org calendar OAuth connections: each organization can authorize its own
-- Google Calendar / Outlook account (tokens stored encrypted at rest with a
-- key derived from SESSION_SECRET). Idempotent — safe to run repeatedly:
--   psql "$DATABASE_URL" -f scripts/db/009_org_calendar_connections.sql

CREATE TABLE IF NOT EXISTS org_calendar_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google_calendar', 'outlook_calendar')),
  account_email text,
  access_token_enc text NOT NULL,
  refresh_token_enc text,
  expires_at timestamptz,
  connected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);

CREATE INDEX IF NOT EXISTS org_calendar_connections_org_idx
  ON org_calendar_connections (organization_id);

-- Which credentials created/own an appointment's external calendar event.
-- Sync must keep using the SAME account that created the event — connecting or
-- disconnecting an org account must never look events up under a different
-- account (a false 404 there would mass-cancel valid appointments).
ALTER TABLE rescue_appointments
  ADD COLUMN IF NOT EXISTS external_credential_source text
  CHECK (external_credential_source IN ('org', 'workspace'));

-- Backfill: every Google/Outlook event synced before per-org OAuth existed was
-- created under the workspace connector.
UPDATE rescue_appointments
SET external_credential_source = 'workspace'
WHERE external_event_id IS NOT NULL
  AND provider IN ('google_calendar', 'outlook_calendar')
  AND external_credential_source IS NULL;
