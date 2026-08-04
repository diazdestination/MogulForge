-- Singleton row tracking when we last emailed admins about a bot-trap spike,
-- so repeated checks during an ongoing spike don't spam.
CREATE TABLE IF NOT EXISTS bot_trap_alert_state (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_alerted_at timestamptz
);
