import "server-only";
import { getPool } from "@/lib/db";
import { readBotTrapStats } from "@/lib/bot-trap-metrics";
import {
  maybeSendBotTrapSpikeAlert,
  type BotTrapAlertDeps,
  type BotTrapSpikeAlertOutcome,
  BOT_TRAP_ALERT_COOLDOWN_MINUTES,
} from "@/lib/bot-trap-alert-core";

export { BOT_TRAP_ALERT_COOLDOWN_MINUTES } from "@/lib/bot-trap-alert-core";
export type { BotTrapSpikeAlertOutcome } from "@/lib/bot-trap-alert-core";

let ensured = false;
async function ensureTable(): Promise<void> {
  if (ensured) return;
  await getPool().query(`CREATE TABLE IF NOT EXISTS bot_trap_alert_state (
    id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_alerted_at timestamptz
  )`);
  ensured = true;
}

function deps(): BotTrapAlertDeps {
  const query: BotTrapAlertDeps["query"] = (text, params) =>
    getPool().query(text, params as unknown[]);
  return { query, env: process.env, fetchFn: fetch };
}

/**
 * Reads current bot-trap stats and emails platform admins if a spike is
 * detected. Deduped via a DB cooldown so ongoing spikes don't spam.
 * Never throws.
 */
export async function checkBotTrapAndAlert(): Promise<BotTrapSpikeAlertOutcome> {
  try {
    await ensureTable();
    const stats = await readBotTrapStats();
    return await maybeSendBotTrapSpikeAlert(deps(), stats);
  } catch (error) {
    console.error("Bot-trap spike check failed", error);
    return "send-failed";
  }
}
