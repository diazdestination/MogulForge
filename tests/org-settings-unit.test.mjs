/**
 * Unit tests for the pure org-settings and report-range modules:
 * normalization must never emit garbage (invalid values fall back to the
 * base), unknown keys are dropped, and date parsing rejects malformed input.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ORG_SETTINGS,
  normalizeOrgSettings,
  touchedSections,
} from "../lib/org-settings-schema.ts";
import { parseReportDate, buildRangePresets, rangeQuery, isoDay } from "../lib/report-range.ts";

// ---------- normalizeOrgSettings ----------

test("empty input yields the defaults", () => {
  assert.deepEqual(normalizeOrgSettings({}), DEFAULT_ORG_SETTINGS);
  assert.deepEqual(normalizeOrgSettings(null), DEFAULT_ORG_SETTINGS);
  assert.deepEqual(normalizeOrgSettings("junk"), DEFAULT_ORG_SETTINGS);
});

test("valid values are accepted and trimmed", () => {
  const out = normalizeOrgSettings({
    contact: { contactName: "  Mike  Rowe ", contactEmail: "MIKE@Example.COM", website: "https://example.com" },
    businessHours: { start: "7:30", end: "17:00", days: [5, 1, 1, 3] },
    notifications: { weeklyDigest: true, notificationEmails: ["A@b.co", "a@b.co", "not-an-email"] },
    messaging: { quietHoursStart: 21, defaultTone: "friendly", defaultSenderName: "Mike" },
  });
  assert.equal(out.contact.contactName, "Mike Rowe");
  assert.equal(out.contact.contactEmail, "mike@example.com");
  assert.equal(out.businessHours.start, "07:30");
  assert.deepEqual(out.businessHours.days, [1, 3, 5]);
  assert.equal(out.notifications.weeklyDigest, true);
  assert.deepEqual(out.notifications.notificationEmails, ["a@b.co"]);
  assert.equal(out.messaging.quietHoursStart, 21);
  assert.equal(out.messaging.defaultTone, "friendly");
});

test("invalid values fall back to the base, never to garbage", () => {
  const out = normalizeOrgSettings({
    contact: { contactEmail: "not-an-email" },
    businessHours: { start: "25:99", days: [9, -1, "x"] },
    messaging: { quietHoursStart: 99, quietHoursEnd: "late", defaultTone: "sarcastic" },
    notifications: { hotLeadAlerts: "yes" },
  });
  assert.equal(out.contact.contactEmail, DEFAULT_ORG_SETTINGS.contact.contactEmail);
  assert.equal(out.businessHours.start, DEFAULT_ORG_SETTINGS.businessHours.start);
  assert.deepEqual(out.businessHours.days, []);
  assert.equal(out.messaging.quietHoursStart, DEFAULT_ORG_SETTINGS.messaging.quietHoursStart);
  assert.equal(out.messaging.quietHoursEnd, DEFAULT_ORG_SETTINGS.messaging.quietHoursEnd);
  assert.equal(out.messaging.defaultTone, "professional");
  assert.equal(out.notifications.hotLeadAlerts, DEFAULT_ORG_SETTINGS.notifications.hotLeadAlerts);
});

test("merging over a stored base only changes submitted fields", () => {
  const stored = normalizeOrgSettings({
    contact: { contactName: "Original", contactPhone: "555" },
    messaging: { defaultSenderName: "Original Sender" },
  });
  const merged = normalizeOrgSettings({ contact: { contactName: "Updated" } }, stored);
  assert.equal(merged.contact.contactName, "Updated");
  assert.equal(merged.contact.contactPhone, "555");
  assert.equal(merged.messaging.defaultSenderName, "Original Sender");
});

test("notification email list caps at 10 unique entries", () => {
  const emails = Array.from({ length: 15 }, (_, i) => `user${i}@example.com`);
  const out = normalizeOrgSettings({ notifications: { notificationEmails: emails } });
  assert.equal(out.notifications.notificationEmails.length, 10);
});

test("touchedSections reports only submitted sections", () => {
  assert.deepEqual(touchedSections({ contact: {}, messaging: {} }), ["contact", "messaging"]);
  assert.deepEqual(touchedSections({ profile: { name: "x" } }), []);
  assert.deepEqual(touchedSections(null), []);
});

// ---------- report range ----------

test("parseReportDate accepts YYYY-MM-DD only", () => {
  assert.equal(parseReportDate("2026-08-01"), "2026-08-01");
  assert.equal(parseReportDate("08/01/2026"), null);
  assert.equal(parseReportDate("2026-13-45"), null);
  assert.equal(parseReportDate(""), null);
  assert.equal(parseReportDate(null), null);
  assert.equal(parseReportDate("2026-08-01T00:00:00Z"), null);
});

test("range presets are well-formed and ordered", () => {
  const now = new Date(2026, 7, 1); // Aug 1 2026 local
  const presets = buildRangePresets(now);
  const last7 = presets.find((p) => p.key === "7d");
  assert.equal(last7.to, "2026-08-01");
  assert.equal(last7.from, "2026-07-26");
  const all = presets.find((p) => p.key === "all");
  assert.equal(all.from, null);
  assert.equal(all.to, null);
  for (const p of presets) {
    if (p.from && p.to) assert.ok(p.from <= p.to, `${p.key} range is ordered`);
  }
});

test("rangeQuery builds the right suffix", () => {
  assert.equal(rangeQuery({ from: "2026-01-01", to: "2026-02-01" }), "?from=2026-01-01&to=2026-02-01");
  assert.equal(rangeQuery({ from: null, to: "2026-02-01" }), "?to=2026-02-01");
  assert.equal(rangeQuery({ from: null, to: null }), "");
});

test("isoDay pads month and day", () => {
  assert.equal(isoDay(new Date(2026, 0, 5)), "2026-01-05");
});
