-- Automatic retry scheduling for failed CRM push deliveries.
-- Failed rows get a next_attempt_at with exponential backoff (mirrors the
-- outgoing-webhook retry pattern); NULL means no automatic retry is pending
-- (succeeded, exhausted, or scheduled retries stopped).

ALTER TABLE crm_push_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_crm_push_deliveries_due
  ON crm_push_deliveries(next_attempt_at)
  WHERE status = 'failed' AND next_attempt_at IS NOT NULL;
