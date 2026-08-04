/**
 * Unit tests for the instant lead-response email core (lib/lead-emails-core.ts):
 * per-report idempotency (no duplicate sends), hot-lead threshold routing,
 * failed sends releasing their claim so retries can send, and the guarantee
 * that email/provider failures never throw into the scan response path.
 *
 * Uses an in-memory claim store and a stubbed fetch — no DB, no real emails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendLeadEmailsCore, hotLeadThreshold } from "../lib/lead-emails-core.ts";

const LEAD = {
  reportId: "11111111-1111-4111-8111-111111111111",
  email: "prospect@example.com",
  url: "https://example.com",
  score: 30,
  summary: "Weak structured data; strong content.",
};

const ENV = { RESEND_API_KEY: "re_test", LEAD_DIGEST_TO: "admin@example.com" };

/** In-memory stand-in for the visibility_reports sent-at claim columns. */
function makeStore() {
  const state = { prospect_email_sent_at: null, hot_alert_sent_at: null };
  return {
    state,
    query: async (sql) => {
      const column = sql.includes("prospect_email_sent_at") ? "prospect_email_sent_at" : "hot_alert_sent_at";
      if (sql.includes("= now()")) {
        if (state[column] !== null) return { rowCount: 0 };
        state[column] = new Date();
        return { rowCount: 1 };
      }
      state[column] = null; // release
      return { rowCount: 1 };
    },
  };
}

function makeFetch({ fail = () => false } = {}) {
  const sent = [];
  const fetchFn = async (url, init) => {
    const body = JSON.parse(init.body);
    if (fail(body)) return { ok: false, status: 500, text: async () => "boom" };
    sent.push(body);
    return { ok: true, status: 200, text: async () => "" };
  };
  return { sent, fetchFn };
}

function deps(store, fetchStub, env = ENV) {
  return { query: store.query, fetchFn: fetchStub.fetchFn, env, siteUrl: "https://mogulforge.test" };
}

test("hot lead sends prospect email and admin alert exactly once, even on retries", async () => {
  const store = makeStore();
  const stub = makeFetch();
  await sendLeadEmailsCore(LEAD, deps(store, stub));
  assert.equal(stub.sent.length, 2);
  assert.equal(stub.sent[0].to, LEAD.email);
  assert.match(stub.sent[0].html, /ai-visibility\/r\/11111111/);
  assert.equal(stub.sent[1].to, ENV.LEAD_DIGEST_TO);
  // Retry: both claims already taken — no duplicate sends.
  await sendLeadEmailsCore(LEAD, deps(store, stub));
  await sendLeadEmailsCore(LEAD, deps(store, stub));
  assert.equal(stub.sent.length, 2);
});

test("no hardcoded reply-to: omitted unless LEAD_DIGEST_REPLY_TO is configured", async () => {
  const stub = makeFetch();
  await sendLeadEmailsCore(LEAD, deps(makeStore(), stub));
  assert.equal("reply_to" in stub.sent[0], false);
  const stub2 = makeFetch();
  await sendLeadEmailsCore(LEAD, deps(makeStore(), stub2, { ...ENV, LEAD_DIGEST_REPLY_TO: "sales@biz.com" }));
  assert.equal(stub2.sent[0].reply_to, "sales@biz.com");
});

test("score at/above threshold sends prospect email but no admin alert", async () => {
  const stub = makeFetch();
  await sendLeadEmailsCore({ ...LEAD, score: 50 }, deps(makeStore(), stub));
  assert.equal(stub.sent.length, 1);
  assert.equal(stub.sent[0].to, LEAD.email);
});

test("HOT_LEAD_THRESHOLD env overrides the default; garbage falls back to 50", () => {
  assert.equal(hotLeadThreshold({}), 50);
  assert.equal(hotLeadThreshold({ HOT_LEAD_THRESHOLD: "65" }), 65);
  assert.equal(hotLeadThreshold({ HOT_LEAD_THRESHOLD: "banana" }), 50);
  assert.equal(hotLeadThreshold({ HOT_LEAD_THRESHOLD: "500" }), 50);
});

test("failed send releases the claim so a later retry sends; never throws", async () => {
  const store = makeStore();
  let failAll = true;
  const stub = makeFetch({ fail: () => failAll });
  // Provider down: nothing sends, but the call resolves without throwing.
  await sendLeadEmailsCore(LEAD, deps(store, stub));
  assert.equal(stub.sent.length, 0);
  assert.equal(store.state.prospect_email_sent_at, null);
  assert.equal(store.state.hot_alert_sent_at, null);
  // Provider recovers: retry sends both.
  failAll = false;
  await sendLeadEmailsCore(LEAD, deps(store, stub));
  assert.equal(stub.sent.length, 2);
});

test("fetch throwing (e.g. timeout abort) never propagates", async () => {
  const store = makeStore();
  const throwingFetch = async () => {
    throw new Error("TimeoutError: signal timed out");
  };
  await sendLeadEmailsCore(LEAD, { query: store.query, fetchFn: throwingFetch, env: ENV, siteUrl: "https://x.test" });
  assert.equal(store.state.prospect_email_sent_at, null); // claim released for retry
});

test("DB claim failure is swallowed — scan response path never breaks", async () => {
  const stub = makeFetch();
  const badQuery = async () => {
    throw new Error("db down");
  };
  await sendLeadEmailsCore(LEAD, { query: badQuery, fetchFn: stub.fetchFn, env: ENV, siteUrl: "https://x.test" });
  assert.equal(stub.sent.length, 0);
});
