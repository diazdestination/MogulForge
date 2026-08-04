import "server-only";
import { getPool } from "@/lib/db";
import type { BotTrapReason } from "@/lib/visibility-schema";
import { computeBotTrapStats, emptyReasonCounts, type BotTrapStats } from "@/lib/bot-trap-metrics-core";

export type { BotTrapStats } from "@/lib/bot-trap-metrics-core";

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await getPool().query(`CREATE TABLE IF NOT EXISTS bot_trap_hits (
    id bigserial PRIMARY KEY,
    reason text NOT NULL CHECK (reason IN ('honeypot', 'missing_elapsed', 'too_fast')),
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await getPool().query(
    "CREATE INDEX IF NOT EXISTS bot_trap_hits_created_at_idx ON bot_trap_hits (created_at)",
  );
  ensured = true;
}

/**
 * Records a single bot-trap hit (reason only — never the bot's data).
 * Never throws: metrics must not break the fake-success response.
 */
export async function recordBotTrapHit(reason: BotTrapReason): Promise<void> {
  try {
    await ensureTable();
    await getPool().query("INSERT INTO bot_trap_hits (reason) VALUES ($1)", [reason]);
  } catch (error) {
    console.error("Failed to record bot-trap hit", error);
  }
}

/** Trap-hit stats for the admin status card. */
export async function readBotTrapStats(): Promise<BotTrapStats> {
  await ensureTable();
  const [recent, baseline] = await Promise.all([
    getPool().query(
      `SELECT reason, count(*)::int AS count FROM bot_trap_hits
       WHERE created_at >= now() - interval '24 hours' GROUP BY reason`,
    ),
    getPool().query(
      `SELECT count(*)::int AS count FROM bot_trap_hits
       WHERE created_at >= now() - interval '8 days' AND created_at < now() - interval '24 hours'`,
    ),
  ]);
  const last24h = emptyReasonCounts();
  for (const row of recent.rows as { reason: BotTrapReason; count: number }[]) {
    if (row.reason in last24h) last24h[row.reason] = row.count;
  }
  return computeBotTrapStats({ last24h, baselineTotal: baseline.rows[0]?.count ?? 0 });
}
