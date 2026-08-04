import test from "node:test";
import assert from "node:assert/strict";
import { encryptToken, decryptToken } from "../lib/calendar/token-crypto.ts";
import {
  buildAuthorizationUrl,
  getOAuthAppCredentials,
  issueOAuthState,
  verifyOAuthState,
  safeReturnTo,
  OAUTH_STATE_TTL_SECONDS,
} from "../lib/calendar/oauth-config.ts";

const SECRET = "unit-test-secret";

test("token crypto round-trips and rejects tampering", () => {
  const blob = encryptToken("ya29.super-secret-token", SECRET);
  assert.ok(blob.startsWith("v1."));
  assert.equal(blob.includes("super-secret-token"), false);
  assert.equal(decryptToken(blob, SECRET), "ya29.super-secret-token");
  // wrong secret
  assert.equal(decryptToken(blob, "other-secret"), null);
  // tampered ciphertext
  const tampered = blob.slice(0, -2) + (blob.endsWith("aa") ? "bb" : "aa");
  assert.equal(decryptToken(tampered, SECRET), null);
  // garbage
  assert.equal(decryptToken("v1.not-base64!!!", SECRET), null);
  assert.equal(decryptToken("nonsense", SECRET), null);
});

test("oauth env credentials require both id and secret", () => {
  assert.equal(getOAuthAppCredentials("google_calendar", {}), null);
  assert.equal(getOAuthAppCredentials("google_calendar", { GOOGLE_OAUTH_CLIENT_ID: "id" }), null);
  assert.deepEqual(
    getOAuthAppCredentials("google_calendar", { GOOGLE_OAUTH_CLIENT_ID: " id ", GOOGLE_OAUTH_CLIENT_SECRET: "sec" }),
    { clientId: "id", clientSecret: "sec" },
  );
  assert.deepEqual(
    getOAuthAppCredentials("outlook_calendar", { MICROSOFT_OAUTH_CLIENT_ID: "mid", MICROSOFT_OAUTH_CLIENT_SECRET: "msec" }),
    { clientId: "mid", clientSecret: "msec" },
  );
});

test("authorization URLs carry the right params", () => {
  const g = new URL(buildAuthorizationUrl("google_calendar", { clientId: "cid", redirectUri: "https://app/cb", state: "st" }));
  assert.equal(g.origin + g.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(g.searchParams.get("client_id"), "cid");
  assert.equal(g.searchParams.get("redirect_uri"), "https://app/cb");
  assert.equal(g.searchParams.get("access_type"), "offline");
  assert.equal(g.searchParams.get("prompt"), "consent");
  assert.match(g.searchParams.get("scope") ?? "", /calendar\.events/);

  const m = new URL(buildAuthorizationUrl("outlook_calendar", { clientId: "cid", redirectUri: "https://app/cb", state: "st" }));
  assert.match(m.href, /login\.microsoftonline\.com/);
  assert.match(m.searchParams.get("scope") ?? "", /offline_access/);
  assert.match(m.searchParams.get("scope") ?? "", /Calendars\.ReadWrite/);
});

test("oauth state round-trips, binds claims, and expires", () => {
  const input = {
    organizationId: "org-1",
    userId: "user-1",
    provider: "google_calendar",
    redirectUri: "https://app/api/calendar/oauth/callback",
    returnTo: "/dashboard/revenue-rescue/appointments?org=acme",
  };
  const now = 1_700_000_000;
  const state = issueOAuthState(input, { secret: SECRET, nowSeconds: now });
  const ok = verifyOAuthState(state, { secret: SECRET, nowSeconds: now + 60 });
  assert.equal(ok.ok, true);
  assert.equal(ok.claims.org, "org-1");
  assert.equal(ok.claims.user, "user-1");
  assert.equal(ok.claims.provider, "google_calendar");
  assert.equal(ok.claims.returnTo, input.returnTo);

  // expired
  const late = verifyOAuthState(state, { secret: SECRET, nowSeconds: now + OAUTH_STATE_TTL_SECONDS + 5 });
  assert.deepEqual(late, { ok: false, reason: "expired" });
  // wrong secret
  assert.equal(verifyOAuthState(state, { secret: "other", nowSeconds: now }).ok, false);
  // tampered payload keeps signature mismatch
  const [payload, sig] = state.split(".");
  const forgedClaims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  forgedClaims.org = "org-2";
  const forged = Buffer.from(JSON.stringify(forgedClaims)).toString("base64url") + "." + sig;
  assert.equal(verifyOAuthState(forged, { secret: SECRET, nowSeconds: now }).ok, false);
});

test("safeReturnTo only allows same-app paths", () => {
  assert.equal(safeReturnTo("/dashboard/x?org=a", "/fb"), "/dashboard/x?org=a");
  assert.equal(safeReturnTo("https://evil.com", "/fb"), "/fb");
  assert.equal(safeReturnTo("//evil.com", "/fb"), "/fb");
  assert.equal(safeReturnTo("/a\\..", "/fb"), "/fb");
  assert.equal(safeReturnTo(undefined, "/fb"), "/fb");
});
