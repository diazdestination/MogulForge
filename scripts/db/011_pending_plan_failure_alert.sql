-- Repeated provider failures on a scheduled plan change: track consecutive
-- failed apply passes and whether the one-time admin alert already went out.
-- Both columns reset when the change is (re)scheduled, cancelled, or applied.
ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_failure_alerted_at timestamptz;
