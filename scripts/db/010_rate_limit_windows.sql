-- Shared fixed-window rate-limit counters so public scan throttles hold
-- across autoscale instances and process restarts.
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  key text PRIMARY KEY,
  window_start bigint NOT NULL,
  count int NOT NULL
);
