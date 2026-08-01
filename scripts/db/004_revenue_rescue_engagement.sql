-- Revenue Rescue: campaigns, messages/conversations, appointments, activities, tasks.
-- Idempotent — safe to run repeatedly. Apply with:
--   psql "$DATABASE_URL" -f scripts/db/004_revenue_rescue_engagement.sql

-- Lead engagement columns: assignment + pipeline stage (the opportunity funnel).
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS pipeline_stage text NOT NULL DEFAULT 'imported';
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz;
ALTER TABLE rescue_leads ADD COLUMN IF NOT EXISTS won_value numeric(12, 2);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rescue_leads_pipeline_stage_check') THEN
    ALTER TABLE rescue_leads ADD CONSTRAINT rescue_leads_pipeline_stage_check CHECK (pipeline_stage IN (
      'imported', 'cleaned', 'analyzed', 'approved', 'contacted', 'replied', 'qualified',
      'appointment_booked', 'estimate_issued', 'won', 'lost', 'suppressed'
    ));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS rescue_leads_org_stage_idx ON rescue_leads (organization_id, pipeline_stage);
CREATE INDEX IF NOT EXISTS rescue_leads_org_assigned_idx ON rescue_leads (organization_id, assigned_user_id) WHERE assigned_user_id IS NOT NULL;

-- Campaigns. mode 'live' requires a connected provider — with none configured,
-- every campaign runs in simulation and is labeled as such.
CREATE TABLE IF NOT EXISTS rescue_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  template_key text,
  objective text,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  tone text NOT NULL DEFAULT 'professional',
  sender_identity text,
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule jsonb NOT NULL DEFAULT '{}'::jsonb,
  approval_mode text NOT NULL DEFAULT 'every_message' CHECK (approval_mode IN ('every_message', 'campaign_templates', 'automation_rules', 'simulation_only')),
  follow_up_delay_days integer NOT NULL DEFAULT 3,
  max_attempts integer NOT NULL DEFAULT 3,
  stop_conditions jsonb NOT NULL DEFAULT '["reply", "opt_out", "appointment_booked"]'::jsonb,
  booking_link text,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  mode text NOT NULL DEFAULT 'simulation' CHECK (mode IN ('simulation', 'live')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  activated_at timestamptz,
  activated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rescue_campaigns_org_idx ON rescue_campaigns (organization_id, created_at DESC);

-- Campaign enrollment: which leads a campaign actually targets, with per-lead outcome.
CREATE TABLE IF NOT EXISTS rescue_campaign_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES rescue_campaigns(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES rescue_leads(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'messaged', 'replied', 'stopped', 'completed')),
  stop_reason text,
  attempts integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS rescue_campaign_leads_org_idx ON rescue_campaign_leads (organization_id, campaign_id);
CREATE INDEX IF NOT EXISTS rescue_campaign_leads_lead_idx ON rescue_campaign_leads (organization_id, lead_id);

-- Message log — outbound sends (simulated or live) and inbound replies.
-- DB-level honesty guarantee: a simulated outbound message can never carry a
-- delivery status; it is 'simulated' forever.
CREATE TABLE IF NOT EXISTS rescue_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES rescue_leads(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES rescue_campaigns(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'call', 'voicemail', 'note')),
  subject text,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('simulated', 'queued', 'sent', 'delivered', 'failed', 'received')),
  simulated boolean NOT NULL DEFAULT true,
  provider text NOT NULL DEFAULT 'simulation',
  provider_message_id text,
  reply_category text,
  reply_confidence real,
  reply_rule text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rescue_messages_simulation_honesty CHECK (direction = 'inbound' OR NOT simulated OR status = 'simulated')
);
CREATE INDEX IF NOT EXISTS rescue_messages_org_lead_idx ON rescue_messages (organization_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rescue_messages_org_campaign_idx ON rescue_messages (organization_id, campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rescue_messages_org_created_idx ON rescue_messages (organization_id, created_at DESC);

-- Provider-neutral appointments. provider 'manual' until a calendar adapter is
-- genuinely connected (Google/Outlook/Calendly adapters are stubs for now).
CREATE TABLE IF NOT EXISTS rescue_appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES rescue_leads(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES rescue_campaigns(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  appointment_type text NOT NULL DEFAULT 'estimate' CHECK (appointment_type IN ('estimate', 'inspection', 'consultation', 'follow_up', 'other')),
  scheduled_start timestamptz NOT NULL,
  scheduled_end timestamptz,
  timezone text,
  address text,
  project_details text,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'rescheduled', 'completed', 'cancelled', 'no_show')),
  provider text NOT NULL DEFAULT 'manual' CHECK (provider IN ('manual', 'google_calendar', 'outlook_calendar', 'calendly', 'booking_url')),
  external_event_id text,
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rescue_appointments_org_idx ON rescue_appointments (organization_id, scheduled_start DESC);
CREATE INDEX IF NOT EXISTS rescue_appointments_lead_idx ON rescue_appointments (organization_id, lead_id);

-- Activity feed — dashboard "recent activity" and the per-lead timeline.
CREATE TABLE IF NOT EXISTS rescue_activities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES rescue_leads(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES rescue_campaigns(id) ON DELETE SET NULL,
  activity_type text NOT NULL,
  title text NOT NULL,
  detail text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rescue_activities_org_idx ON rescue_activities (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rescue_activities_lead_idx ON rescue_activities (organization_id, lead_id, created_at DESC) WHERE lead_id IS NOT NULL;

-- Follow-up tasks created by reply rules ("follow up later", escalations) or manually.
CREATE TABLE IF NOT EXISTS rescue_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES rescue_leads(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES rescue_campaigns(id) ON DELETE SET NULL,
  assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  detail text,
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'reply_rule', 'escalation')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS rescue_tasks_org_idx ON rescue_tasks (organization_id, status, due_at NULLS LAST);
CREATE INDEX IF NOT EXISTS rescue_tasks_assigned_idx ON rescue_tasks (organization_id, assigned_user_id) WHERE assigned_user_id IS NOT NULL;
