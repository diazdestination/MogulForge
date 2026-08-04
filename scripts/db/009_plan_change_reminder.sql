-- ---------------------------------------------------------------------------
-- Downgrade reminder emails: a background pass emails the org's notification
-- recipients ~3 days before a scheduled plan change takes effect. This flag
-- records that the reminder for the current pending change was sent (or
-- deliberately skipped by org preferences) so re-runs never duplicate it.
-- Cleared whenever the pending change is (re)scheduled, cancelled, or applied.
-- ---------------------------------------------------------------------------
ALTER TABLE org_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_reminder_sent_at timestamptz;
