-- Lead follow-up status on visibility reports (idempotent)
ALTER TABLE visibility_reports
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new'
  CHECK (status IN ('new', 'contacted', 'dismissed'));
