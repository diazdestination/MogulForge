/**
 * Bot-trap spike alert core (dependency-injected, no server imports).
 *
 * When readBotTrapStats() reports spike=true the cron check emails platform
 * admins so over-blocking is caught within hours rather than days.
 * A DB-backed cooldown singleton (bot_trap_alert_state) prevents spam while
 * the spike persists — modelled on the stale-scheduler alert in
 * lib/cron-heartbeat-core.ts.
 */

import type { BotTrapStats } from "@/lib/bot-trap-metrics-core";

export type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number | null };
export type QueryFn = (text: string, params?: unknown[]) => Promise<QueryResult>;

export type BotTrapAlertDeps = {
  query: QueryFn;
  env: Record<string, string | undefined>;
  fetchFn: typeof fetch;
};

/** Minimum gap between repeated spike-alert emails for the same ongoing spike. */
export const BOT_TRAP_ALERT_COOLDOWN_MINUTES = 6 * 60;

const SEND_TIMEOUT_MS = 10_000;

export type BotTrapSpikeAlertOutcome =
  | "sent"
  | "healthy"
  | "cooldown"
  | "not-configured"
  | "send-failed";

/**
 * Emails platform admins when bot-trap hits are spiking.
 * Deduped via a DB cooldown claim so concurrent checks don't spam.
 */
export async function maybeSendBotTrapSpikeAlert(
  deps: BotTrapAlertDeps,
  stats: BotTrapStats,
): Promise<BotTrapSpikeAlertOutcome> {
  if (!stats.spike) return "healthy";

  const apiKey = deps.env.RESEND_API_KEY;
  const to = deps.env.LEAD_DIGEST_TO;
  if (!apiKey || !to) return "not-configured";

  // Atomic cooldown claim: only the first caller inside the window sends.
  const claim = await deps.query(
    `INSERT INTO bot_trap_alert_state (id, last_alerted_at) VALUES (1, now())
     ON CONFLICT (id) DO UPDATE SET last_alerted_at = now()
     WHERE bot_trap_alert_state.last_alerted_at IS NULL
        OR bot_trap_alert_state.last_alerted_at < now() - ($1 || ' minutes')::interval
     RETURNING id`,
    [String(BOT_TRAP_ALERT_COOLDOWN_MINUTES)],
  );
  if ((claim.rowCount ?? 0) === 0) return "cooldown";

  const from = deps.env.LEAD_DIGEST_FROM ?? "MogulForge <onboarding@resend.dev>";
  const subject = "MogulForge: bot-trap spike detected";
  const { last24hTotal, baselinePerDay, last24h } = stats;
  const baseline = baselinePerDay > 0 ? baselinePerDay.toFixed(1) : "0";
  const breakdown = [
    `honeypot: ${last24h.honeypot}`,
    `missing elapsed: ${last24h.missing_elapsed}`,
    `too fast: ${last24h.too_fast}`,
  ].join(", ");

  const html = `<p>The scan-form bot trap has blocked <strong>${last24hTotal} requests in the last 24 hours</strong> — well above the recent baseline of ${baseline}/day.</p>
<p><strong>Breakdown:</strong> ${breakdown}</p>
<p>This could mean a bot campaign is underway, <em>or</em> that the trap's thresholds are accidentally blocking real visitors. Check the Admin → Organizations page for the live chart before deciding whether to tighten or relax the thresholds.</p>
<p>You will not receive another alert for this spike for at least ${BOT_TRAP_ALERT_COOLDOWN_MINUTES / 60} hours.</p>`;

  try {
    const response = await deps.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Resend API error ${response.status}`);
    return "sent";
  } catch (error) {
    console.error("Bot-trap spike alert email failed", error);
    // Release the cooldown claim so a later check can retry.
    await deps
      .query(`UPDATE bot_trap_alert_state SET last_alerted_at = NULL WHERE id = 1`)
      .catch((releaseError) =>
        console.error("Failed to release bot-trap alert cooldown", releaseError),
      );
    return "send-failed";
  }
}
