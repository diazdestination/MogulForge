-- Health tracking for per-org calendar OAuth connections. Repeated token
-- refresh failures flip the connection to 'error' (instead of erroring
-- forever), which surfaces "Reconnect" in the Appointments UI and triggers a
-- notification email. Idempotent — safe to run repeatedly:
--   psql "$DATABASE_URL" -f scripts/db/012_org_calendar_connection_status.sql

ALTER TABLE org_calendar_connections
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'error'));

ALTER TABLE org_calendar_connections
  ADD COLUMN IF NOT EXISTS refresh_failure_count integer NOT NULL DEFAULT 0;

ALTER TABLE org_calendar_connections
  ADD COLUMN IF NOT EXISTS last_refresh_error text;
