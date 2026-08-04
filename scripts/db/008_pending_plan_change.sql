-- ---------------------------------------------------------------------------
-- Scheduled plan downgrades: self-serve downgrades no longer apply instantly.
-- The target plan and its effective date (next usage-period start, UTC) are
-- stored here and applied by the plan-change cron/timer pass (or lazily when
-- the org's Plan & Usage page is viewed after the date has passed).
-- ---------------------------------------------------------------------------
ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_id text REFERENCES plan_definitions(id);
ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_effective_at timestamptz;
