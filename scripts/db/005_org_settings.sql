-- Organization settings: contact details, business hours, notification
-- preferences, and messaging defaults stored as a validated jsonb blob.
-- Idempotent — safe to run repeatedly. Apply with:
--   psql "$DATABASE_URL" -f scripts/db/005_org_settings.sql

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
