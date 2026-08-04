-- Repeated provider failures on a scheduled plan change: track consecutive
-- failed apply passes and whether the one-time admin alert already went out.
-- Both columns reset when the change is (re)scheduled, cancelled, or applied.
ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_failed_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_failure_alerted_at timestamptz;
-- Timestamp of the most recent failed apply attempt; drives exponential backoff
-- so a broken provider is not hammered on every cron/timer/page-load pass.
-- Reset when the change is (re)scheduled, cancelled, or finally applied.
ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_last_failed_at timestamptz;
