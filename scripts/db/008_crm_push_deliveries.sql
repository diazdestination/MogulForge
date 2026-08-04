-- Per-connection CRM push delivery log + consecutive-failure tracking.
-- Mirrors the outgoing-webhook deliveries pattern so clients can see exactly
-- which leads failed to reach their CRM and retry them.

CREATE TABLE IF NOT EXISTS crm_push_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES crm_connections(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES rescue_leads(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_push_deliveries_conn ON crm_push_deliveries(connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_push_deliveries_org ON crm_push_deliveries(organization_id, created_at DESC);

-- Consecutive push failures per connection; repeated failures flip status to 'error'.
ALTER TABLE crm_connections ADD COLUMN IF NOT EXISTS push_failure_count INTEGER NOT NULL DEFAULT 0;
