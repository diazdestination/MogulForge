import test from "node:test";
import assert from "node:assert/strict";
import { cnameMatchesTarget, domainGoLiveChecklist } from "../lib/custom-domain-core.ts";

test("cnameMatchesTarget matches case-insensitively and ignores trailing dots", () => {
  assert.equal(cnameMatchesTarget(["Portal.Example.COM."], "portal.example.com"), true);
  assert.equal(cnameMatchesTarget(["portal.example.com"], "Portal.Example.com."), true);
  assert.equal(cnameMatchesTarget(["other.example.com"], "portal.example.com"), false);
  assert.equal(cnameMatchesTarget([], "portal.example.com"), false);
  assert.equal(cnameMatchesTarget(["portal.example.com"], ""), false);
});

test("checklist: pending_dns — nothing done, TXT guidance shown", () => {
  const steps = domainGoLiveChecklist({ status: "pending_dns", sslStatus: "not_provisioned" });
  assert.deepEqual(steps.map((s) => s.done), [false, false, false, false]);
  assert.match(steps[0].detail, /TXT record/);
});

test("checklist: verified — DNS done, activation pending with cutover note", () => {
  const steps = domainGoLiveChecklist({ status: "verified", sslStatus: "not_provisioned" });
  assert.deepEqual(steps.map((s) => s.done), [true, false, false, false]);
  assert.match(steps[1].detail, /cutover/);
});

test("checklist: active with pending SSL — shows certificate-setup remaining step", () => {
  const steps = domainGoLiveChecklist({ status: "active", sslStatus: "pending" });
  assert.deepEqual(steps.map((s) => s.done), [true, true, false, false]);
  assert.equal(steps[2].detail, "MogulForge is finishing certificate setup.");
  assert.match(steps[3].detail, /first secure request/);
});

test("checklist: active with issued SSL — everything done, no details", () => {
  const steps = domainGoLiveChecklist({ status: "active", sslStatus: "issued" });
  assert.deepEqual(steps.map((s) => s.done), [true, true, true, true]);
  assert.deepEqual(steps.map((s) => s.detail), [null, null, null, null]);
});
