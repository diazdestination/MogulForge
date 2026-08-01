-- Usage metering, subscription plans, branding/white-label, and custom domains.
-- Idempotent: safe to re-run. Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/006_usage_plans_branding.sql

-- ---------------------------------------------------------------------------
-- Plan definitions: the admin-editable source of truth for the public pricing
-- cards AND per-plan usage limits. `limits` is jsonb keyed by usage metric
-- (leads_stored, leads_imported, ai_jobs, sms_sent, emails_sent, api_requests,
-- messages_generated, webhook_events, seats) — an absent key means unlimited.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_definitions (
  id text PRIMARY KEY,
  name text NOT NULL,
  blurb text NOT NULL DEFAULT '',
  price numeric(10, 2) NOT NULL DEFAULT 0,
  cadence text NOT NULL DEFAULT 'per month' CHECK (cadence IN ('per month', 'one-time')),
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  featured boolean NOT NULL DEFAULT false,
  is_public boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed: public Revenue Rescue plans (previously hardcoded in lib/rescue-config.ts)
-- plus the legacy internal plan tiers and an unlimited internal plan.
-- ON CONFLICT DO NOTHING so admin edits are never overwritten by re-running.
INSERT INTO plan_definitions (id, name, blurb, price, cadence, features, limits, featured, is_public, sort_order) VALUES
  ('core', 'Revenue Rescue Core', 'The essential reactivation system for a single pipeline.', 997, 'per month',
   '["Up to 2,500 stored leads","Monthly lead imports","Lead cleanup and deduplication","AI analysis and scoring","Email campaign preparation","Revenue dashboard","One CRM or webhook connection","Three users"]'::jsonb,
   '{"seats":3,"leads_stored":2500,"leads_imported":2500,"ai_jobs":2500,"emails_sent":5000,"sms_sent":0}'::jsonb,
   false, true, 10),
  ('pro', 'Revenue Rescue Pro', 'Multi-channel outreach with reply handling and CRM sync.', 1497, 'per month',
   '["Up to 10,000 stored leads","SMS and email campaigns","Reply classification","Appointment routing","Five users","CRM synchronization","Monthly performance reporting"]'::jsonb,
   '{"seats":5,"leads_stored":10000,"leads_imported":10000,"ai_jobs":10000,"emails_sent":25000,"sms_sent":5000}'::jsonb,
   true, true, 20),
  ('complete', 'Complete Revenue Engine', 'The full MogulForge growth stack around Revenue Rescue.', 2497, 'per month',
   '["Revenue Rescue","AI Front Desk","Lead CRM","Voice and SMS","Email automation","Appointment scheduling","Review automation","Lead attribution","Advanced reporting"]'::jsonb,
   '{"seats":15,"leads_stored":50000,"leads_imported":50000,"ai_jobs":50000,"emails_sent":100000,"sms_sent":25000,"api_requests":100000}'::jsonb,
   false, true, 30),
  ('sprint', 'Revenue Rescue Sprint', 'The initial cleanup, analysis, and reactivation service for your existing lead database.', 3500, 'one-time',
   '["Full lead-database import and cleanup","Deduplication and suppression handling","AI scoring of every dormant opportunity","Personalized reactivation campaigns prepared","Recovered-pipeline report"]'::jsonb,
   '{}'::jsonb,
   false, true, 40),
  ('starter', 'Starter', 'Legacy internal tier.', 0, 'per month', '[]'::jsonb,
   '{"seats":3,"leads_imported":500,"ai_jobs":0,"sms_sent":0,"emails_sent":2000}'::jsonb, false, false, 110),
  ('growth', 'Growth', 'Legacy internal tier.', 0, 'per month', '[]'::jsonb,
   '{"seats":10,"leads_imported":2500,"ai_jobs":2500,"sms_sent":0,"emails_sent":10000}'::jsonb, false, false, 120),
  ('scale', 'Scale', 'Legacy internal tier.', 0, 'per month', '[]'::jsonb,
   '{"seats":25,"leads_imported":10000,"ai_jobs":10000,"sms_sent":5000,"emails_sent":50000}'::jsonb, false, false, 130),
  ('enterprise', 'Enterprise', 'Legacy internal tier.', 0, 'per month', '[]'::jsonb,
   '{"seats":100,"leads_imported":100000,"ai_jobs":100000,"sms_sent":50000,"emails_sent":500000}'::jsonb, false, false, 140),
  ('internal', 'Internal (MogulForge)', 'Unmetered internal/test account.', 0, 'per month', '[]'::jsonb,
   '{}'::jsonb, false, false, 200)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Org subscriptions: which plan an organization is on, its account state, and
-- the billing-provider linkage (adapter-neutral — no provider is hardcoded).
-- Statuses: trialing | active | past_due | suspended | internal | cancelled.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS org_subscriptions (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES plan_definitions(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing', 'active', 'past_due', 'suspended', 'internal', 'cancelled')),
  trial_ends_at timestamptz,
  billing_provider text NOT NULL DEFAULT 'manual',
  billing_ref text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Usage metering: one counter row per org + period ('YYYY-MM', UTC) + metric.
-- Increments are single-row upserts; rollups are direct indexed reads.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_records (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period text NOT NULL,
  metric text NOT NULL,
  quantity bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, period, metric)
);
CREATE INDEX IF NOT EXISTS usage_records_period_idx ON usage_records (period);

-- Distinct active users per org per period (the active_users counter mirrors
-- the number of rows inserted here).
CREATE TABLE IF NOT EXISTS usage_active_users (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period text NOT NULL,
  user_id uuid NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, period, user_id)
);

-- Fired usage warnings (75/90/100% of a limit), one row per threshold crossing
-- per period — visible in the client dashboard and the admin usage console.
CREATE TABLE IF NOT EXISTS usage_warnings (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period text NOT NULL,
  metric text NOT NULL,
  threshold integer NOT NULL CHECK (threshold IN (75, 90, 100)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, period, metric, threshold)
);
CREATE INDEX IF NOT EXISTS usage_warnings_period_idx ON usage_warnings (period, created_at DESC);

-- ---------------------------------------------------------------------------
-- Organization branding / white-label fields. branding_level:
--   mogulforge  — standard MogulForge-branded portal
--   powered_by  — client brand + "Powered by MogulForge" attribution
--   white_label — full white label (requires the white_label entitlement;
--                 enforced server-side, downgraded to powered_by otherwise)
-- ---------------------------------------------------------------------------
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS branding_level text NOT NULL DEFAULT 'mogulforge',
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS portal_title text,
  ADD COLUMN IF NOT EXISTS login_title text,
  ADD COLUMN IF NOT EXISTS support_email text,
  ADD COLUMN IF NOT EXISTS support_phone text,
  ADD COLUMN IF NOT EXISTS email_sender_name text,
  ADD COLUMN IF NOT EXISTS sms_sender_name text,
  ADD COLUMN IF NOT EXISTS powered_by_label text;

-- ---------------------------------------------------------------------------
-- Custom domains: requested domain + verification token/status + required DNS
-- records + SSL/activation status. Activation is gated on verification and
-- uniqueness; actual traffic routing/SSL issuance is manual/platform-dependent.
-- Statuses: pending_dns | verified | active | removed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain text NOT NULL,
  verification_token text NOT NULL,
  status text NOT NULL DEFAULT 'pending_dns' CHECK (status IN ('pending_dns', 'verified', 'active', 'removed')),
  ssl_status text NOT NULL DEFAULT 'not_provisioned' CHECK (ssl_status IN ('not_provisioned', 'pending', 'issued')),
  required_dns jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at timestamptz,
  last_check_error text,
  verified_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS custom_domains_org_idx ON custom_domains (organization_id);
-- A domain can only be claimed once across all organizations (removed rows aside).
CREATE UNIQUE INDEX IF NOT EXISTS custom_domains_domain_unique ON custom_domains (lower(domain)) WHERE status <> 'removed';
