import test from "node:test";
import assert from "node:assert/strict";
import { initialCampaignForm } from "../lib/rescue-engage/campaign-prefill.ts";
import { CAMPAIGN_TEMPLATES } from "../lib/rescue-engage/campaign-templates.ts";

const savedDefaults = {
  quietHoursStart: 21,
  quietHoursEnd: 9,
  defaultTone: "urgent",
  defaultSenderName: "Sam from Acme Roofing",
  defaultBookingLink: "https://calendly.com/acme/estimate",
};

test("no defaults → blank campaign uses built-in values (behaves as before)", () => {
  const form = initialCampaignForm(null, null);
  assert.equal(form.tone, "professional");
  assert.equal(form.quietHoursStart, 20);
  assert.equal(form.quietHoursEnd, 8);
  assert.equal(form.senderIdentity, "");
  assert.equal(form.bookingLink, "");
  assert.equal(form.channel, "sms");
  assert.equal(form.templateKey, null);
});

test("no defaults → template campaign keeps the template's values", () => {
  const t = CAMPAIGN_TEMPLATES[1]; // friendly email template
  const form = initialCampaignForm(t, null);
  assert.equal(form.tone, t.tone);
  assert.equal(form.channel, t.channel);
  assert.equal(form.name, t.name);
  assert.equal(form.quietHoursStart, 20);
  assert.equal(form.quietHoursEnd, 8);
});

test("saved defaults prefill tone, sender, booking link, and quiet hours on blank campaigns", () => {
  const form = initialCampaignForm(null, savedDefaults);
  assert.equal(form.tone, "urgent");
  assert.equal(form.quietHoursStart, 21);
  assert.equal(form.quietHoursEnd, 9);
  assert.equal(form.senderIdentity, "Sam from Acme Roofing");
  assert.equal(form.bookingLink, "https://calendly.com/acme/estimate");
});

test("saved default tone wins over the template tone; template content is kept", () => {
  const t = CAMPAIGN_TEMPLATES[0];
  const form = initialCampaignForm(t, savedDefaults);
  assert.equal(form.tone, "urgent");
  assert.equal(form.templateKey, t.key);
  assert.equal(form.name, t.name);
  assert.equal(form.objective, t.objective);
  assert.deepEqual(form.categories, t.audience.categories);
  assert.equal(form.senderIdentity, "Sam from Acme Roofing");
  assert.equal(form.quietHoursStart, 21);
  assert.equal(form.quietHoursEnd, 9);
});
