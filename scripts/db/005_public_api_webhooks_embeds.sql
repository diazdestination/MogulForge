-- Revenue Rescue: public API keys, incoming/outgoing webhooks, embeds & CRM framework.
-- Idempotent / re-runnable. Apply with: psql "$DATABASE_URL" -f scripts/db/005_public_api_webhooks_embeds.sql

-- ---- API keys ---------------------------------------------------------------
-- Full keys are never stored: only a SHA-256 hash plus a display prefix.
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  rotated_from UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(organization_id);

-- Idempotency-Key replay storage for sensitive writes on the public API.
CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, endpoint, idempotency_key)
);

-- Cheap daily request counters powering the /api/v1/usage resource.
CREATE TABLE IF NOT EXISTS api_usage_counters (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, day)
);

-- ---- Incoming webhooks --------------------------------------------------------
-- Org-specific signed endpoints external systems POST events to.
CREATE TABLE IF NOT EXISTS incoming_webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  -- Shared secret used by the sender to sign requests; needed in clear to verify HMACs.
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  last_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incoming_webhook_endpoints_org ON incoming_webhook_endpoints(organization_id);

CREATE TABLE IF NOT EXISTS incoming_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES incoming_webhook_endpoints(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'skipped', 'failed')),
  result TEXT,
  error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_incoming_webhook_events_org ON incoming_webhook_events(organization_id, created_at DESC);

-- ---- Outgoing webhooks --------------------------------------------------------
CREATE TABLE IF NOT EXISTS outgoing_webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  description TEXT,
  -- Per-endpoint signing secret (shown to the client so they can verify our signatures).
  secret TEXT NOT NULL,
  event_types TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outgoing_webhook_endpoints_org ON outgoing_webhook_endpoints(organization_id);

CREATE TABLE IF NOT EXISTS outgoing_webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id UUID NOT NULL REFERENCES outgoing_webhook_endpoints(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'exhausted', 'disabled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outgoing_deliveries_endpoint ON outgoing_webhook_deliveries(endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outgoing_deliveries_due ON outgoing_webhook_deliveries(next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- ---- CRM connections & field mapping -------------------------------------------
CREATE TABLE IF NOT EXISTS crm_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'testing', 'active', 'disabled', 'error')),
  sync_direction TEXT NOT NULL DEFAULT 'outbound' CHECK (sync_direction IN ('outbound', 'inbound', 'bidirectional')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_mapping JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_test_at TIMESTAMPTZ,
  last_test_result JSONB,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_connections_org ON crm_connections(organization_id);

-- Sync conflicts are recorded for manual review — newer local data is never overwritten.
CREATE TABLE IF NOT EXISTS crm_sync_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES crm_connections(id) ON DELETE SET NULL,
  lead_id UUID NOT NULL REFERENCES rescue_leads(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'incoming_webhook',
  fields JSONB NOT NULL DEFAULT '[]'::jsonb,
  local_updated_at TIMESTAMPTZ,
  remote_updated_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied_remote', 'kept_local', 'dismissed')),
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_sync_conflicts_org ON crm_sync_conflicts(organization_id, status);
