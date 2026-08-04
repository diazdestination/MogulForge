import test from "node:test";
import assert from "node:assert/strict";
import {
  recordCronHeartbeat,
  getSchedulerHealth,
  maybeSendStaleSchedulerAlert,
  STALE_AFTER_MINUTES,
  ALERT_COOLDOWN_MINUTES,
} from "../lib/cron-heartbeat-core.ts";

// In-memory fake of the two heartbeat tables, matching the SQL the core issues.
function makeState({ lastSuccessAt = null, lastAlertedAt = undefined } = {}) {
  const state = {
    lastSuccessAt, // Date | null — max(last_success_at)
    lastAlertedAt, // Date | null | undefined (undefined = no row)
    queries: [],
    failNext: null,
  };
  const query = async (text, params) => {
    state.queries.push({ text, params });
    if (state.failNext) {
      const error = state.failNext;
      state.failNext = null;
      throw error;
    }
    if (text.includes("INSERT INTO cron_heartbeats")) {
      state.lastSuccessAt = new Date();
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("SELECT max(last_success_at)")) {
      return { rows: [{ last: state.lastSuccessAt }], rowCount: 1 };
    }
    if (text.includes("INSERT INTO cron_alert_state")) {
      const cooldownMs = ALERT_COOLDOWN_MINUTES * 60_000;
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
    if (text.includes("UPDATE cron_alert_state SET last_alerted_at = NULL")) {
      state.lastAlertedAt = null;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  return { state, query };
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000);

test("recordCronHeartbeat upserts and never throws on DB failure", async () => {
  const { state, query } = makeState();
  await recordCronHeartbeat({ query }, "lead-digest");
  assert.ok(state.lastSuccessAt instanceof Date);

  state.failNext = new Error("db down");
  await recordCronHeartbeat({ query }, "lead-digest"); // must not throw
});

test("getSchedulerHealth: never seen => stale with no heartbeat", async () => {
  const { query } = makeState();
  const health = await getSchedulerHealth({ query, now: () => new Date() });
  assert.equal(health.hasHeartbeat, false);
  assert.equal(health.stale, true);
  assert.equal(health.lastSuccessAt, null);
});

test("getSchedulerHealth: recent hit is healthy, old hit is stale", async () => {
  const recent = makeState({ lastSuccessAt: minutesAgo(5) });
  const healthy = await getSchedulerHealth({ query: recent.query, now: () => new Date() });
  assert.equal(healthy.stale, false);
  assert.equal(healthy.hasHeartbeat, true);

  const old = makeState({ lastSuccessAt: minutesAgo(STALE_AFTER_MINUTES + 5) });
  const stale = await getSchedulerHealth({ query: old.query, now: () => new Date() });
  assert.equal(stale.stale, true);
  assert.ok(stale.minutesSinceLast >= STALE_AFTER_MINUTES);
});

function alertDeps(stateFns, { env, fetchFn } = {}) {
  return {
    query: stateFns.query,
    now: () => new Date(),
    env: env ?? { RESEND_API_KEY: "re_test", LEAD_DIGEST_TO: "admin@example.com" },
    fetchFn: fetchFn ?? (async () => ({ ok: true, text: async () => "" })),
  };
}

test("alert: healthy scheduler sends nothing", async () => {
  const s = makeState({ lastSuccessAt: minutesAgo(5) });
  assert.equal(await maybeSendStaleSchedulerAlert(alertDeps(s)), "healthy");
});

test("alert: never-seen scheduler does not email (banner only)", async () => {
  const s = makeState();
  assert.equal(await maybeSendStaleSchedulerAlert(alertDeps(s)), "no-heartbeat-yet");
});

test("alert: stale scheduler emails admins once, then respects cooldown", async () => {
  const s = makeState({ lastSuccessAt: minutesAgo(120) });
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, text: async () => "" };
  };
  const deps = alertDeps(s, { fetchFn });
  assert.equal(await maybeSendStaleSchedulerAlert(deps), "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].body.to, "admin@example.com");
  assert.match(calls[0].body.subject, /scheduler/i);

  // Second check inside the cooldown window: no second email.
  assert.equal(await maybeSendStaleSchedulerAlert(deps), "cooldown");
  assert.equal(calls.length, 1);
});

test("alert: missing email config is a no-op", async () => {
  const s = makeState({ lastSuccessAt: minutesAgo(120) });
  const deps = alertDeps(s, { env: {} });
  assert.equal(await maybeSendStaleSchedulerAlert(deps), "not-configured");
});

test("alert: failed send releases the cooldown claim for retry", async () => {
  const s = makeState({ lastSuccessAt: minutesAgo(120) });
  let attempt = 0;
  const fetchFn = async () => {
    attempt++;
    if (attempt === 1) return { ok: false, status: 500, text: async () => "boom" };
    return { ok: true, text: async () => "" };
  };
  const deps = alertDeps(s, { fetchFn });
  assert.equal(await maybeSendStaleSchedulerAlert(deps), "send-failed");
  assert.equal(s.state.lastAlertedAt, null); // claim released
  assert.equal(await maybeSendStaleSchedulerAlert(deps), "sent");
});
