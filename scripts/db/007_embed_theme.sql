-- Per-org embed theme defaults (widget/dashboard branding for client sites).
-- Idempotent: safe to re-run. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/007_embed_theme.sql

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS embed_theme jsonb NOT NULL DEFAULT '{}'::jsonb;
