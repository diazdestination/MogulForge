-- Bot-trap hit log for the scan form (app/api/ai-visibility).
-- Records only WHY the trap fired and WHEN — never the bot's submitted data —
-- so admins can spot the trap suddenly blocking real visitors at scale.
CREATE TABLE IF NOT EXISTS bot_trap_hits (
  id bigserial PRIMARY KEY,
  reason text NOT NULL CHECK (reason IN ('honeypot', 'missing_elapsed', 'too_fast')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bot_trap_hits_created_at_idx ON bot_trap_hits (created_at);
