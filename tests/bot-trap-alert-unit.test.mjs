/**
 * Unit tests for the bot-trap spike alert (lib/bot-trap-alert-core.ts).
 * Covers: healthy (no spike), sent, cooldown, not-configured, send-failed.
 * Mirrors the pattern in tests/cron-heartbeat-unit.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  maybeSendBotTrapSpikeAlert,
  BOT_TRAP_ALERT_COOLDOWN_MINUTES,
} from "../lib/bot-trap-alert-core.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an in-memory fake of bot_trap_alert_state.
 *
 * lastAlertedAt:
 *   undefined → no row exists yet (first-ever check)
 *   null      → row exists but last_alerted_at IS NULL (claim released)
 *   Date      → row exists with a timestamp
 */
function makeState({ lastAlertedAt = undefined } = {}) {
  const state = {
    lastAlertedAt,
    queries: [],
    failNextRelease: false,
  };

  const query = async (text, params) => {
    state.queries.push({ text, params });

    // Atomic cooldown claim (INSERT ... ON CONFLICT DO UPDATE ... RETURNING id)
    if (text.includes("INSERT INTO bot_trap_alert_state")) {
      const cooldownMs = BOT_TRAP_ALERT_COOLDOWN_MINUTES * 60_000;
      const eligible =
        state.lastAlertedAt === undefined ||
        state.lastAlertedAt === null ||
        Date.now() - state.lastAlertedAt.getTime() > cooldownMs;
      if (eligible) {
        state.lastAlertedAt = new Date();
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Release claim after a send failure
    if (text.includes("UPDATE bot_trap_alert_state SET last_alerted_at = NULL")) {
      if (state.failNextRelease) {
        state.failNextRelease = false;
        throw new Error("DB release failed");
      }
      state.lastAlertedAt = null;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${text}`);
  };

  return { state, query };
}

/** Minimal BotTrapStats with spike=true (well above both thresholds). */
function spikeStats() {
  return {
    last24h: { honeypot: 30, missing_elapsed: 10, too_fast: 5 },
    last24hTotal: 45,
    baselinePerDay: 1,
    baselineTotal: 7,
    spike: true,
  };
}

/** BotTrapStats with spike=false (quiet traffic). */
function healthyStats() {
  return {
    last24h: { honeypot: 1, missing_elapsed: 0, too_fast: 0 },
    last24hTotal: 1,
    baselinePerDay: 2,
    baselineTotal: 14,
    spike: false,
  };
}

/** Default deps with a working Resend stub. */
function makeDeps(stateFns, { env, fetchFn } = {}) {
  return {
    query: stateFns.query,
    env: env ?? { RESEND_API_KEY: "re_test", LEAD_DIGEST_TO: "admin@example.com" },
    fetchFn: fetchFn ?? (async () => ({ ok: true })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("healthy: no spike returns 'healthy' without hitting the DB", async () => {
  const s = makeState();
  const outcome = await maybeSendBotTrapSpikeAlert(makeDeps(s), healthyStats());
  assert.equal(outcome, "healthy");
  assert.equal(s.state.queries.length, 0, "no DB queries expected");
});

test("spike: first check emails admins and returns 'sent'", async () => {
  const s = makeState();
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  const outcome = await maybeSendBotTrapSpikeAlert(makeDeps(s, { fetchFn }), spikeStats());
  assert.equal(outcome, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].body.to, "admin@example.com");
  assert.match(calls[0].body.subject, /bot-trap/i);
  assert.ok(calls[0].body.html.includes("45"), "email should mention total hit count");
});

test("cooldown: second check inside window returns 'cooldown' without emailing", async () => {
  const s = makeState();
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  const deps = makeDeps(s, { fetchFn });

  assert.equal(await maybeSendBotTrapSpikeAlert(deps, spikeStats()), "sent");
  assert.equal(calls.length, 1);

  // Immediately repeat — still inside the cooldown window.
  assert.equal(await maybeSendBotTrapSpikeAlert(deps, spikeStats()), "cooldown");
  assert.equal(calls.length, 1, "no second email should be sent");
});

test("cooldown: check after window expires emails again", async () => {
  // Seed with a last_alerted_at well outside the cooldown window.
  const pastMs = (BOT_TRAP_ALERT_COOLDOWN_MINUTES + 10) * 60_000;
  const s = makeState({ lastAlertedAt: new Date(Date.now() - pastMs) });
  const calls = [];
  const fetchFn = async () => {
    calls.push(1);
    return { ok: true };
  };
  const outcome = await maybeSendBotTrapSpikeAlert(makeDeps(s, { fetchFn }), spikeStats());
  assert.equal(outcome, "sent");
  assert.equal(calls.length, 1, "alert should fire after the cooldown expires");
});

test("not-configured: missing env vars is a no-op", async () => {
  const s = makeState();
  const outcome = await maybeSendBotTrapSpikeAlert(
    makeDeps(s, { env: {} }),
    spikeStats(),
  );
  assert.equal(outcome, "not-configured");
  assert.equal(s.state.queries.length, 0);
});

test("not-configured: missing RESEND_API_KEY only", async () => {
  const s = makeState();
  const outcome = await maybeSendBotTrapSpikeAlert(
    makeDeps(s, { env: { LEAD_DIGEST_TO: "admin@example.com" } }),
    spikeStats(),
  );
  assert.equal(outcome, "not-configured");
});

test("not-configured: missing LEAD_DIGEST_TO only", async () => {
  const s = makeState();
  const outcome = await maybeSendBotTrapSpikeAlert(
    makeDeps(s, { env: { RESEND_API_KEY: "re_test" } }),
    spikeStats(),
  );
  assert.equal(outcome, "not-configured");
});

test("send-failed: Resend error releases cooldown claim so next check can retry", async () => {
  const s = makeState();
  let attempt = 0;
  const fetchFn = async () => {
    attempt++;
    if (attempt === 1) return { ok: false, status: 500 };
    return { ok: true };
  };
  const deps = makeDeps(s, { fetchFn });

  assert.equal(await maybeSendBotTrapSpikeAlert(deps, spikeStats()), "send-failed");
  assert.equal(s.state.lastAlertedAt, null, "cooldown claim must be released after failure");

  // Retry succeeds because the claim was released.
  assert.equal(await maybeSendBotTrapSpikeAlert(deps, spikeStats()), "sent");
  assert.equal(attempt, 2);
});

test("send-failed: fetch throwing also releases the cooldown claim", async () => {
  const s = makeState();
  let attempt = 0;
  const fetchFn = async () => {
    attempt++;
    if (attempt === 1) throw new Error("network timeout");
    return { ok: true };
  };
  const deps = makeDeps(s, { fetchFn });

  assert.equal(await maybeSendBotTrapSpikeAlert(deps, spikeStats()), "send-failed");
  assert.equal(s.state.lastAlertedAt, null);
  assert.equal(await maybeSendBotTrapSpikeAlert(deps, spikeStats()), "sent");
});
