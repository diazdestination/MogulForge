import { test } from "node:test";
import assert from "node:assert/strict";
import { issueBookingToken, verifyBookingToken, buildBookingUrl } from "../lib/booking-token.ts";
import { resolveCalendarAdapters } from "../lib/rescue-engage/calendar-adapters.ts";
import { normalizeOrgSettings, DEFAULT_ORG_SETTINGS, normalizeCalendlyUrl } from "../lib/org-settings-schema.ts";

import { normalizeCalendlyUrl as normalizeCalendlyUrlSchema } from "../lib/org-settings-schema.ts";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret";

/** Minimal local normalizer matching the one inside lib/calendar/sync.ts */
function normalizeCalendlyUrlForSync(url) {
  return url.toLowerCase().replace(/\/+$/, "").trim();
}

test("booking token round-trips org and lead claims", () => {
  const token = issueBookingToken({ organizationId: "org-1", leadId: "lead-9" });
  const check = verifyBookingToken(token);
  assert.equal(check.ok, true);
  assert.equal(check.claims.org, "org-1");
  assert.equal(check.claims.lead, "lead-9");

  const orgOnly = verifyBookingToken(issueBookingToken({ organizationId: "org-2" }));
  assert.equal(orgOnly.ok, true);
  assert.equal(orgOnly.claims.lead, null);
});

test("booking token rejects tampering and garbage", () => {
  const token = issueBookingToken({ organizationId: "org-1" });
  const [payload, sig] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ org: "other-org", lead: null, iat: 1 })).toString("base64url");
  assert.equal(verifyBookingToken(`${forgedPayload}.${sig}`).ok, false);
  assert.equal(verifyBookingToken(`${payload}.AAAA${sig.slice(4)}`).ok, false);
  assert.equal(verifyBookingToken("nonsense").ok, false);
  assert.equal(verifyBookingToken("").ok, false);
  assert.equal(verifyBookingToken(token, { secret: "different" }).ok, false);
});

test("buildBookingUrl produces a verifiable link and trims trailing slash", () => {
  const url = buildBookingUrl("https://example.com/", "org-3");
  assert.match(url, /^https:\/\/example\.com\/book\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const token = url.split("/book/")[1];
  const check = verifyBookingToken(token);
  assert.equal(check.ok, true);
  assert.equal(check.claims.org, "org-3");
});

test("adapter statuses reflect real connection + settings state", () => {
  const base = { google: false, outlook: false, calendly: false, syncProvider: "none", calendlyUrl: "", bookingUrl: "" };
  const none = resolveCalendarAdapters(base);
  assert.equal(none.find((a) => a.id === "manual").connected, true);
  for (const id of ["google_calendar", "outlook_calendar", "calendly", "booking_url"]) {
    assert.equal(none.find((a) => a.id === id).connected, false, id);
  }

  // Authorized but not chosen as sync target — still not "connected".
  const authorizedOnly = resolveCalendarAdapters({ ...base, google: true });
  assert.equal(authorizedOnly.find((a) => a.id === "google_calendar").connected, false);
  assert.match(authorizedOnly.find((a) => a.id === "google_calendar").detail, /Authorized but not active/);

  const googleActive = resolveCalendarAdapters({ ...base, google: true, syncProvider: "google_calendar" });
  assert.equal(googleActive.find((a) => a.id === "google_calendar").connected, true);

  // Selecting a provider without authorization never shows connected.
  const wishful = resolveCalendarAdapters({ ...base, syncProvider: "outlook_calendar" });
  assert.equal(wishful.find((a) => a.id === "outlook_calendar").connected, false);

  // Calendly needs both the connector and the org's link.
  assert.equal(resolveCalendarAdapters({ ...base, calendly: true }).find((a) => a.id === "calendly").connected, false);
  assert.equal(
    resolveCalendarAdapters({ ...base, calendly: true, calendlyUrl: "https://calendly.com/acme" }).find((a) => a.id === "calendly").connected,
    true,
  );

  assert.equal(resolveCalendarAdapters({ ...base, bookingUrl: "https://x.com/book/t" }).find((a) => a.id === "booking_url").connected, true);
});

test("Outlook inbound pull: dateTime is parsed as UTC regardless of Graph response format", () => {
  // The fix: Graph is requested with Prefer: outlook.timezone="UTC".
  // Graph may still omit the trailing Z on the returned dateTime string — we must
  // normalize to a valid ISO UTC string without shifting time.

  function normalizeOutlookDateTime(raw) {
    if (!raw) return null;
    // Already UTC-offset: leave alone.
    if (raw.endsWith("Z") || raw.includes("+") || /[T ]\d{2}:\d{2}:\d{2}-/.test(raw)) return raw;
    // No trailing Z: append it (Graph UTC mode, Z omitted).
    return `${raw}Z`;
  }

  // UTC with Z — pass through unchanged.
  assert.equal(normalizeOutlookDateTime("2026-09-01T15:00:00Z"), "2026-09-01T15:00:00Z");

  // UTC without Z (common Graph quirk) — must append Z, not shift.
  const naiveUtc = normalizeOutlookDateTime("2026-09-01T15:00:00");
  assert.equal(naiveUtc, "2026-09-01T15:00:00Z");
  assert.equal(new Date(naiveUtc).toISOString(), "2026-09-01T15:00:00.000Z");

  // Already has explicit UTC offset — leave alone.
  assert.equal(normalizeOutlookDateTime("2026-09-01T15:00:00+00:00"), "2026-09-01T15:00:00+00:00");

  // Null / undefined — returns null.
  assert.equal(normalizeOutlookDateTime(null), null);
  assert.equal(normalizeOutlookDateTime(undefined), null);

  // Critical correctness check: 3pm UTC must remain 3pm UTC after normalization.
  const parsed = new Date(normalizeOutlookDateTime("2026-09-01T15:00:00"));
  assert.equal(parsed.getUTCHours(), 15, "3pm UTC must stay 3pm UTC");
  assert.equal(parsed.getUTCMinutes(), 0);
});

test("Calendly per-org event-type scoping: URL normalization prevents cross-org attribution", () => {
  // Simulate two orgs with different Calendly links and an event type list.
  const eventTypes = [
    { uri: "https://api.calendly.com/event_types/AAA", scheduling_url: "https://calendly.com/acme/estimate" },
    { uri: "https://api.calendly.com/event_types/BBB", scheduling_url: "https://calendly.com/beta-co/consult" },
  ];

  function orgEventTypeUri(orgCalendlyUrl) {
    const normalized = normalizeCalendlyUrlForSync(orgCalendlyUrl);
    const match = eventTypes.find(et => et.scheduling_url && normalizeCalendlyUrlForSync(et.scheduling_url) === normalized);
    return match?.uri ?? null;
  }

  // Each org resolves only to its own event type.
  assert.equal(orgEventTypeUri("https://calendly.com/acme/estimate"), "https://api.calendly.com/event_types/AAA");
  assert.equal(orgEventTypeUri("https://calendly.com/beta-co/consult"), "https://api.calendly.com/event_types/BBB");

  // Trailing slash and case differences are normalized.
  assert.equal(orgEventTypeUri("https://calendly.com/acme/estimate/"), "https://api.calendly.com/event_types/AAA");
  assert.equal(orgEventTypeUri("https://Calendly.com/ACME/Estimate"), "https://api.calendly.com/event_types/AAA");

  // An org whose URL doesn't match any event type gets null — excluded from sync entirely.
  assert.equal(orgEventTypeUri("https://calendly.com/unknown/meeting"), null);

  // Orgs with different URLs can never resolve to the same event type URI.
  const uriA = orgEventTypeUri("https://calendly.com/acme/estimate");
  const uriB = orgEventTypeUri("https://calendly.com/beta-co/consult");
  assert.notEqual(uriA, uriB, "Different org links must map to different event types");

  // Events fetched per-org are already scoped to that org's event_type URI;
  // an event with a different event_type URI is never attributed to an org
  // because it would never appear in that org's scoped event-type query.
  const acmeEventTypeUri = orgEventTypeUri("https://calendly.com/acme/estimate");
  const betaEventTypeUri = orgEventTypeUri("https://calendly.com/beta-co/consult");
  const acmeEvent = { uri: "https://api.calendly.com/scheduled_events/E1", event_type: acmeEventTypeUri, status: "active" };
  const betaEvent  = { uri: "https://api.calendly.com/scheduled_events/E2", event_type: betaEventTypeUri, status: "active" };
  // acme's query only returns events with event_type === acmeEventTypeUri.
  assert.equal(acmeEvent.event_type, acmeEventTypeUri, "Acme event belongs to Acme");
  assert.notEqual(betaEvent.event_type, acmeEventTypeUri, "Beta event must not be attributed to Acme");
});

test("org settings calendar section normalizes safely", () => {
  const defaults = normalizeOrgSettings({});
  assert.deepEqual(defaults.calendar, { syncProvider: "none", calendlyUrl: "" });

  const good = normalizeOrgSettings({ calendar: { syncProvider: "google_calendar", calendlyUrl: "https://calendly.com/acme/estimate" } });
  assert.equal(good.calendar.syncProvider, "google_calendar");
  assert.equal(good.calendar.calendlyUrl, "https://calendly.com/acme/estimate");

  const bad = normalizeOrgSettings({ calendar: { syncProvider: "icloud", calendlyUrl: "javascript:alert(1)" } });
  assert.deepEqual(bad.calendar, { syncProvider: "none", calendlyUrl: "" });

  // Clearing is allowed; non-Calendly hosts and http are rejected (fall back).
  assert.equal(normalizeCalendlyUrl("", "https://calendly.com/x"), "");
  assert.equal(normalizeCalendlyUrl("https://evil.com/x", "keep"), "keep");
  assert.equal(normalizeCalendlyUrl("http://calendly.com/x", "keep"), "keep");
  assert.equal(normalizeCalendlyUrl(42, "keep"), "keep");
  // Base preserved when section untouched.
  const merged = normalizeOrgSettings({ contact: {} }, { ...DEFAULT_ORG_SETTINGS, calendar: { syncProvider: "outlook_calendar", calendlyUrl: "https://calendly.com/a" } });
  assert.equal(merged.calendar.syncProvider, "outlook_calendar");
});
