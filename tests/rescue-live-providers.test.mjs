/**
 * Unit tests for the live provider adapters (pure parts): env-driven credential
 * detection, webhook signature verification, and quiet-hours math.
 * No network, no DB — safe to run standalone:
 *   node --test tests/rescue-live-providers.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  getProviderStatus,
  liveSendingAvailable,
  providerName,
  validateResendSignature,
  validateTwilioSignature,
} from "../lib/rescue-engage/providers.ts";
import { isWithinQuietHours } from "../lib/rescue-engage/campaign-schema.ts";

const PROVIDER_ENV = [
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "TWILIO_MESSAGING_SERVICE_SID",
  "OUTREACH_RESEND_API_KEY", "OUTREACH_EMAIL_FROM",
];

function withEnv(vars, fn) {
  const saved = {};
  for (const key of PROVIDER_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, vars);
  try {
    fn();
  } finally {
    for (const key of PROVIDER_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("providers stay honestly disconnected without credentials", () => {
  withEnv({}, () => {
    for (const channel of ["sms", "email"]) {
      const status = getProviderStatus(channel);
      assert.equal(status.connected, false);
      assert.equal(status.providerLabel, null);
      assert.equal(liveSendingAvailable(channel), false);
      assert.match(status.detail, /Simulation Mode/);
    }
  });
});

test("partial Twilio credentials do not count as connected", () => {
  withEnv({ TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok" }, () => {
    assert.equal(getProviderStatus("sms").connected, false, "needs a sender number or messaging service");
  });
  withEnv({ TWILIO_ACCOUNT_SID: "AC123", TWILIO_PHONE_NUMBER: "+15551234567" }, () => {
    assert.equal(getProviderStatus("sms").connected, false, "needs an auth token");
  });
});

test("full Twilio credentials enable live SMS", () => {
  withEnv({ TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "tok", TWILIO_PHONE_NUMBER: "+15551234567" }, () => {
    const status = getProviderStatus("sms");
    assert.equal(status.connected, true);
    assert.equal(status.providerLabel, "Twilio");
    assert.equal(liveSendingAvailable("sms"), true);
    assert.equal(getProviderStatus("email").connected, false, "email stays disconnected independently");
  });
});

test("outreach email requires its own key AND a From address (internal digest key never counts)", () => {
  withEnv({ OUTREACH_RESEND_API_KEY: "re_key" }, () => {
    assert.equal(getProviderStatus("email").connected, false);
  });
  withEnv({ OUTREACH_RESEND_API_KEY: "re_key", OUTREACH_EMAIL_FROM: "Acme <hello@acme.com>" }, () => {
    const status = getProviderStatus("email");
    assert.equal(status.connected, true);
    assert.equal(status.providerLabel, "Resend");
  });
});

test("provider names recorded on live messages", () => {
  assert.equal(providerName("sms"), "twilio");
  assert.equal(providerName("email"), "resend_outreach");
});

test("Twilio signature validation accepts a correct signature and rejects tampering", () => {
  const token = "test_auth_token";
  const url = "https://example.com/api/webhooks/twilio/inbound";
  const params = { Body: "STOP", From: "+15551230000", MessageSid: "SM123" };
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const good = createHmac("sha1", token).update(data).digest("base64");
  assert.equal(validateTwilioSignature(url, params, good, token), true);
  assert.equal(validateTwilioSignature(url, { ...params, Body: "YES" }, good, token), false);
  assert.equal(validateTwilioSignature(url, params, null, token), false);
  assert.equal(validateTwilioSignature(url, params, good, ""), false, "no token configured → always invalid");
});

test("Resend (svix) signature validation: valid, expired, and wrong-secret cases", () => {
  const secret = "whsec_" + Buffer.from("supersecretkey1234").toString("base64");
  const body = JSON.stringify({ type: "email.delivered", data: { email_id: "abc" } });
  const id = "msg_1";
  const ts = String(Math.floor(1_800_000_000));
  const nowMs = 1_800_000_000 * 1000;
  const key = Buffer.from(secret.slice(6), "base64");
  const sig = "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  const headers = { svixId: id, svixTimestamp: ts, svixSignature: sig };
  assert.equal(validateResendSignature(body, headers, secret, nowMs), true);
  assert.equal(validateResendSignature(body + " ", headers, secret, nowMs), false, "tampered body");
  assert.equal(validateResendSignature(body, headers, secret, nowMs + 10 * 60 * 1000), false, "outside replay window");
  assert.equal(validateResendSignature(body, headers, "whsec_" + Buffer.from("other").toString("base64"), nowMs), false);
});

test("quiet hours wrap midnight and can be disabled", () => {
  const schedule = { quietHoursStart: 20, quietHoursEnd: 8 };
  assert.equal(isWithinQuietHours(schedule, 21), true);
  assert.equal(isWithinQuietHours(schedule, 3), true);
  assert.equal(isWithinQuietHours(schedule, 12), false);
  assert.equal(isWithinQuietHours(schedule, 8), false, "end hour is sending-allowed");
  assert.equal(isWithinQuietHours({ quietHoursStart: 9, quietHoursEnd: 17 }, 12), true, "non-wrapping window");
  assert.equal(isWithinQuietHours({ quietHoursStart: 9, quietHoursEnd: 9 }, 9), false, "equal start/end disables quiet hours");
});
