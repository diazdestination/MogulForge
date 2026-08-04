/**
 * Unit tests for the HubSpot / GoHighLevel adapter request/response shaping in
 * lib/crm/adapters.ts, run against a stubbed global fetch (no network):
 * - the exact HubSpot contact-create body (properties payload, default mapping,
 *   string coercion, empty values dropped) and auth/headers/URL
 * - the 409 existing-contact PATCH path (id parsed from the error message),
 *   PATCH failure, and 409 without a parsable id
 * - the exact GHL upsert body including locationId, URL, and Version header
 * - pull parsing for both providers' response shapes, including missing fields
 *
 *   node --test tests/crm-adapters-unit.test.mjs
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("./helpers/server-lib-loader.mjs", import.meta.url);

const {
  pushLeadHubSpot,
  pullHubSpotContacts,
  pushLeadGhl,
  pullGhlContacts,
  HUBSPOT_DEFAULT_MAPPING,
  GHL_DEFAULT_MAPPING,
} = await import("../lib/crm/adapters.ts");

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Captured requests + a scripted queue of responses. */
const calls = [];
let responses = [];

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls.length = 0;
  responses = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response left for " + url);
    return next;
  };
});

const HS = { accessToken: "pat-na1-test-token" };
const GHL = { apiKey: "pit-test-key", locationId: "loc_ABC123" };

const LEAD = {
  firstName: "Casey",
  lastName: "Nguyen",
  email: "Casey@Example.COM",
  phone: "(555) 644-9001",
  address: "1 Main St",
  city: "Austin",
  state: "TX",
  zip: "78701",
  notes: "", // empty — must be dropped from payloads
};

// ---------- HubSpot push ----------

test("hubspot push: exact contact-create body, URL, and auth header", async () => {
  responses = [jsonResponse(201, { id: "9001" })];
  const result = await pushLeadHubSpot(HS, [], LEAD);

  assert.deepEqual(result, { ok: true, statusCode: 201, message: "Contact created in HubSpot." });
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://api.hubapi.com/crm/v3/objects/contacts");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, "Bearer pat-na1-test-token");
  assert.equal(call.headers["content-type"], "application/json");
  // Default mapping: HubSpot property names, lowercased email, E.164 phone,
  // no empty/absent values, and every value a string.
  assert.deepEqual(call.body, {
    properties: {
      firstname: "Casey",
      lastname: "Nguyen",
      email: "casey@example.com",
      phone: "+15556449001",
      city: "Austin",
      state: "TX",
      zip: "78701",
    },
  });
});

test("hubspot push: custom mapping wins over the default and coerces to strings", async () => {
  responses = [jsonResponse(201, { id: "1" })];
  await pushLeadHubSpot(HS, [{ source: "score", target: "hs_lead_score", transform: "none" }], { ...LEAD, score: 87 });
  assert.deepEqual(calls[0].body, { properties: { hs_lead_score: "87" } });
});

test("hubspot push: 409 conflict PATCHes the existing contact with the same properties", async () => {
  responses = [
    jsonResponse(409, { message: "Contact already exists. Existing ID: 424242" }),
    jsonResponse(200, { id: "424242" }),
  ];
  const result = await pushLeadHubSpot(HS, [], LEAD);
  assert.deepEqual(result, { ok: true, statusCode: 200, message: "Existing HubSpot contact 424242 updated." });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://api.hubapi.com/crm/v3/objects/contacts/424242");
  assert.equal(calls[1].method, "PATCH");
  assert.equal(calls[1].headers.authorization, "Bearer pat-na1-test-token");
  // The PATCH sends the identical properties payload as the create attempt.
  assert.deepEqual(calls[1].body, calls[0].body);
});

test("hubspot push: 409 with failing PATCH reports the failure honestly", async () => {
  responses = [jsonResponse(409, { message: "Existing ID: 7" }), jsonResponse(403, { message: "forbidden" })];
  const result = await pushLeadHubSpot(HS, [], LEAD);
  assert.deepEqual(result, { ok: false, statusCode: 403, message: "Contact exists but update failed (HTTP 403)." });
});

test("hubspot push: 409 without a parsable id counts as already-exists success", async () => {
  responses = [jsonResponse(409, { message: "Conflict, no id here" })];
  const result = await pushLeadHubSpot(HS, [], LEAD);
  assert.deepEqual(result, { ok: true, statusCode: 409, message: "Contact already exists in HubSpot." });
  assert.equal(calls.length, 1); // no PATCH attempted
});

test("hubspot push: non-409 error surfaces the status", async () => {
  responses = [jsonResponse(429, { message: "rate limited" })];
  const result = await pushLeadHubSpot(HS, [], LEAD);
  assert.deepEqual(result, { ok: false, statusCode: 429, message: "HubSpot responded with HTTP 429." });
});

test("hubspot push: network failure returns ok:false with a null status", async () => {
  const result = await pushLeadHubSpot(HS, [], LEAD); // no scripted response → fetch throws
  assert.equal(result.ok, false);
  assert.equal(result.statusCode, null);
});

// ---------- HubSpot pull ----------

test("hubspot pull: search request shape and contact parsing incl. missing fields", async () => {
  responses = [
    jsonResponse(200, {
      results: [
        {
          id: "101",
          properties: { firstname: "Ana", lastname: "Silva", email: "ana@x.com", phone: "+15551234567", lastmodifieddate: "2026-08-01T00:00:00Z" },
        },
        { id: "102", properties: { firstname: "Ben" }, updatedAt: "2026-07-30T00:00:00Z" },
        { id: "103" }, // no properties at all
      ],
    }),
  ];
  const result = await pullHubSpotContacts(HS, 25);
  assert.equal(result.ok, true);

  const call = calls[0];
  assert.equal(call.url, "https://api.hubapi.com/crm/v3/objects/contacts/search");
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, {
    limit: 25,
    sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }],
    properties: ["firstname", "lastname", "email", "phone", "lastmodifieddate"],
  });

  assert.deepEqual(result.contacts, [
    { externalRecordId: "hubspot:101", email: "ana@x.com", phone: "+15551234567", firstName: "Ana", lastName: "Silva", updatedAt: "2026-08-01T00:00:00Z" },
    { externalRecordId: "hubspot:102", email: null, phone: null, firstName: "Ben", lastName: null, updatedAt: "2026-07-30T00:00:00Z" },
    { externalRecordId: "hubspot:103", email: null, phone: null, firstName: null, lastName: null, updatedAt: null },
  ]);
});

test("hubspot pull: limit is capped at 100 and missing results key yields empty list", async () => {
  responses = [jsonResponse(200, {})];
  const result = await pullHubSpotContacts(HS, 500);
  assert.equal(calls[0].body.limit, 100);
  assert.deepEqual(result, { ok: true, message: "Fetched 0 contacts.", contacts: [] });
});

test("hubspot pull: error status returns ok:false and no contacts", async () => {
  responses = [jsonResponse(401, { message: "bad token" })];
  const result = await pullHubSpotContacts(HS);
  assert.deepEqual(result, { ok: false, message: "HubSpot responded with HTTP 401.", contacts: [] });
});

// ---------- GHL push ----------

test("ghl push: exact upsert body including locationId, URL, and Version header", async () => {
  responses = [jsonResponse(200, { contact: { id: "c1" } })];
  const result = await pushLeadGhl(GHL, [], LEAD);
  assert.deepEqual(result, { ok: true, statusCode: 200, message: "Contact upserted in GoHighLevel." });

  const call = calls[0];
  assert.equal(call.url, "https://services.leadconnectorhq.com/contacts/upsert");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.authorization, "Bearer pit-test-key");
  assert.equal(call.headers.version, "2021-07-28");
  // Default mapping: GHL field names, locationId always present, empty values dropped.
  assert.deepEqual(call.body, {
    locationId: "loc_ABC123",
    firstName: "Casey",
    lastName: "Nguyen",
    email: "casey@example.com",
    phone: "+15556449001",
    address1: "1 Main St",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
  });
});

test("ghl push: locationId is kept even with a custom mapping", async () => {
  responses = [jsonResponse(200, {})];
  await pushLeadGhl(GHL, [{ source: "email", target: "email", transform: "lowercase" }], LEAD);
  assert.deepEqual(calls[0].body, { locationId: "loc_ABC123", email: "casey@example.com" });
});

test("ghl push: error status surfaces honestly", async () => {
  responses = [jsonResponse(422, { message: "invalid" })];
  const result = await pushLeadGhl(GHL, [], LEAD);
  assert.deepEqual(result, { ok: false, statusCode: 422, message: "GoHighLevel responded with HTTP 422." });
});

// ---------- GHL pull ----------

test("ghl pull: request URL carries encoded locationId + capped limit; parsing handles missing fields", async () => {
  responses = [
    jsonResponse(200, {
      contacts: [
        { id: "g1", email: "a@x.com", phone: "+15550000001", firstName: "Ana", lastName: "Silva", dateUpdated: "2026-08-02T00:00:00Z" },
        { id: "g2", firstName: "Ben" }, // sparse contact
      ],
    }),
  ];
  const result = await pullGhlContacts({ apiKey: "k", locationId: "loc with space" }, 500);
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://services.leadconnectorhq.com/contacts/?locationId=loc%20with%20space&limit=100");
  assert.deepEqual(result.contacts, [
    { externalRecordId: "ghl:g1", email: "a@x.com", phone: "+15550000001", firstName: "Ana", lastName: "Silva", updatedAt: "2026-08-02T00:00:00Z" },
    { externalRecordId: "ghl:g2", email: null, phone: null, firstName: "Ben", lastName: null, updatedAt: null },
  ]);
});

test("ghl pull: missing contacts key yields empty list; error status returns ok:false", async () => {
  responses = [jsonResponse(200, {})];
  assert.deepEqual(await pullGhlContacts(GHL), { ok: true, message: "Fetched 0 contacts.", contacts: [] });

  responses = [jsonResponse(403, { message: "no" })];
  assert.deepEqual(await pullGhlContacts(GHL), { ok: false, message: "GoHighLevel responded with HTTP 403.", contacts: [] });
});

// ---------- Default mappings stay aligned with provider property names ----------

test("default mappings target the providers' canonical field names", () => {
  assert.deepEqual(
    HUBSPOT_DEFAULT_MAPPING.map((m) => m.target),
    ["firstname", "lastname", "email", "phone", "city", "state", "zip"],
  );
  assert.deepEqual(
    GHL_DEFAULT_MAPPING.map((m) => m.target),
    ["firstName", "lastName", "email", "phone", "address1", "city", "state", "postalCode"],
  );
});
