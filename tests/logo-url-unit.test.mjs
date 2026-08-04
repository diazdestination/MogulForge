import test from "node:test";
import assert from "node:assert/strict";
import { checkLogoUrl, isPrivateAddress } from "../lib/logo-url-core.ts";

test("checkLogoUrl accepts public https/http URLs and relative paths", () => {
  assert.deepEqual(checkLogoUrl("https://cdn.example.com/logo.png"), { ok: true, kind: "absolute" });
  assert.deepEqual(checkLogoUrl("http://assets.example.com/l.png"), { ok: true, kind: "absolute" });
  assert.deepEqual(checkLogoUrl("/uploads/logo.png"), { ok: true, kind: "relative" });
});

test("checkLogoUrl rejects SSRF shapes: IPs, localhost, internal suffixes, schemes", () => {
  const bad = [
    "http://127.0.0.1/x.png",
    "http://10.0.0.5/x.png",
    "https://169.254.169.254/latest/meta-data",
    "http://192.168.1.1/x",
    "http://localhost/x.png",
    "http://foo.localhost/x.png",
    "http://db.internal/x.png",
    "http://printer.local/x.png",
    "http://[::1]/x.png",
    "http://intranet/x.png", // single-label host
    "file:///etc/passwd",
    "ftp://example.com/x.png",
    "gopher://example.com/",
    "http://user:pass@example.com/x.png",
    "//evil.example.com/x.png", // protocol-relative is not a safe relative path
    "",
    "not a url",
  ];
  for (const url of bad) {
    assert.equal(checkLogoUrl(url).ok, false, `should reject: ${url}`);
  }
});

test("isPrivateAddress flags private/loopback/link-local/reserved ranges", () => {
  const priv = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.169.254",
    "0.0.0.0", "100.64.0.1", "192.0.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1"];
  for (const ip of priv) assert.equal(isPrivateAddress(ip), true, `should be private: ${ip}`);
});

test("isPrivateAddress passes public addresses", () => {
  const pub = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1", "2606:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of pub) assert.equal(isPrivateAddress(ip), false, `should be public: ${ip}`);
});
