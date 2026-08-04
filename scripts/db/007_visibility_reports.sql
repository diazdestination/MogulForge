-- AI Visibility scan leads: email captured before the full report is shown.
-- Idempotent; the table may already exist in older environments.
CREATE TABLE IF NOT EXISTS visibility_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  email text NOT NULL,
  score integer NOT NULL,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS visibility_reports_created_idx ON visibility_reports (created_at DESC);
