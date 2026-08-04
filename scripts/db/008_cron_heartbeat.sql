-- Scheduler heartbeat: cron routes record their last successful external hit
-- so admins can be warned when the external scheduler goes quiet.
CREATE TABLE IF NOT EXISTS cron_heartbeats (
  job text PRIMARY KEY,
  last_success_at timestamptz NOT NULL DEFAULT now()
);

-- Singleton row tracking when we last emailed admins about a stale scheduler,
-- so repeated checks don't spam.
CREATE TABLE IF NOT EXISTS cron_alert_state (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_alerted_at timestamptz
);
