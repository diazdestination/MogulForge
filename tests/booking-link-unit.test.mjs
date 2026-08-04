/**
 * Unit tests for the {{booking_link}} campaign placeholder: interpolation,
 * per-lead resolution order (literal URL → minted /book token → org default →
 * Calendly → stripped), and the booking call-to-action in template drafts.
 * Pure-module tests — run directly against the TypeScript sources.
 *
 *   node --test tests/booking-link-unit.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-booking-link";

const {
  BOOKING_LINK_PLACEHOLDER,
  containsBookingPlaceholder,
  isBookingPlaceholderOnly,
  interpolateBookingLink,
  resolveBookingLink,
} = await import("../lib/rescue-engage/booking-link.ts");
const { verifyBookingToken } = await import("../lib/booking-token.ts");
const { buildTemplateDraft } = await import("../lib/rescue-analysis/message-content.ts");

const ORG = "11111111-1111-1111-1111-111111111111";
const LEAD = "22222222-2222-2222-2222-222222222222";

function lead(overrides = {}) {
  return {
    firstName: "Maria",
    lastName: "Lopez",
    email: "maria@example.com",
    emailNormalized: "maria@example.com",
    phone: "(555) 201-7788",
    phoneNormalized: "+15552017788",
    city: "Dallas",
    state: "TX",
    projectType: "Roof replacement",
    projectDescription: null,
    estimatedValue: null,
    source: null,
    firstContactDate: null,
    lastContactDate: null,
    estimateDate: null,
    notes: null,
    consentStatus: "express",
    ...overrides,
  };
}

test("placeholder detection is whitespace and case tolerant", () => {
  assert.equal(containsBookingPlaceholder("Book here: {{booking_link}}"), true);
  assert.equal(containsBookingPlaceholder("{{ Booking_Link }}"), true);
  assert.equal(containsBookingPlaceholder("no placeholder"), false);
  assert.equal(containsBookingPlaceholder(null), false);
  assert.equal(isBookingPlaceholderOnly("  {{booking_link}} "), true);
  assert.equal(isBookingPlaceholderOnly("x {{booking_link}}"), false);
});

test("interpolateBookingLink replaces every occurrence", () => {
  const out = interpolateBookingLink("A {{booking_link}} B {{ booking_link }}", "https://x.test/book/t");
  assert.equal(out, "A https://x.test/book/t B https://x.test/book/t");
});

test("interpolateBookingLink strips the placeholder when no URL resolved", () => {
  const out = interpolateBookingLink("Grab a time: {{booking_link}} today", "");
  assert.ok(!out.includes("{{"));
  assert.ok(!out.includes("  "));
});

test("literal campaign URL wins over minting", () => {
  const url = resolveBookingLink({
    organizationId: ORG,
    leadId: LEAD,
    campaignBookingLink: "https://calendly.com/acme/estimate",
    defaultBookingLink: "",
    calendlyUrl: "",
    baseUrl: "https://app.test",
  });
  assert.equal(url, "https://calendly.com/acme/estimate");
});

test("placeholder mints a per-lead /book token carrying org and lead ids", () => {
  const url = resolveBookingLink({
    organizationId: ORG,
    leadId: LEAD,
    campaignBookingLink: BOOKING_LINK_PLACEHOLDER,
    defaultBookingLink: "",
    calendlyUrl: "https://calendly.com/acme/fallback",
    baseUrl: "https://app.test",
  });
  assert.ok(url.startsWith("https://app.test/book/"));
  const token = url.slice("https://app.test/book/".length);
  const check = verifyBookingToken(token);
  assert.equal(check.ok, true);
  assert.equal(check.claims.org, ORG);
  assert.equal(check.claims.lead, LEAD);
});

test("falls back to default booking link, then Calendly, when minting unavailable", () => {
  const withDefault = resolveBookingLink({
    organizationId: ORG,
    leadId: LEAD,
    campaignBookingLink: BOOKING_LINK_PLACEHOLDER,
    defaultBookingLink: "https://calendly.com/acme/default",
    calendlyUrl: "https://calendly.com/acme/cal",
    baseUrl: null,
  });
  assert.equal(withDefault, "https://calendly.com/acme/default");
  const withCalendly = resolveBookingLink({
    organizationId: ORG,
    leadId: LEAD,
    campaignBookingLink: "",
    defaultBookingLink: "",
    calendlyUrl: "https://calendly.com/acme/cal",
    baseUrl: null,
  });
  assert.equal(withCalendly, "https://calendly.com/acme/cal");
  const nothing = resolveBookingLink({
    organizationId: ORG,
    leadId: LEAD,
    campaignBookingLink: "",
    defaultBookingLink: "",
    calendlyUrl: "",
    baseUrl: null,
  });
  assert.equal(nothing, "");
});

test("SMS draft includes the booking CTA before opt-out language", () => {
  const draft = buildTemplateDraft("sms", lead(), {
    orgName: "Acme Roofing",
    tone: "professional",
    includeOptOutLanguage: true,
    bookingLink: "https://app.test/book/tok",
  });
  assert.ok(String(draft.body).includes("https://app.test/book/tok"));
  assert.ok(String(draft.body).indexOf("https://app.test/book/tok") < String(draft.body).indexOf("Reply STOP"));
});

test("email draft includes the booking CTA; drafts without a link are unchanged", () => {
  const withLink = buildTemplateDraft("email", lead(), {
    orgName: "Acme Roofing",
    tone: "friendly",
    includeOptOutLanguage: true,
    bookingLink: "https://app.test/book/tok",
  });
  assert.ok(String(withLink.body).includes("https://app.test/book/tok"));
  const without = buildTemplateDraft("email", lead(), {
    orgName: "Acme Roofing",
    tone: "friendly",
    includeOptOutLanguage: true,
  });
  assert.ok(!String(without.body).includes("book"));
});
