/**
 * Custom-domain validation + DNS/activation rules — pure module (unit-testable).
 *
 * MogulForge stores and verifies domain requests; actual traffic routing and
 * SSL issuance for custom domains are manual/platform-dependent (documented in
 * the admin UI). Activation is gated: never before verification, and a domain
 * can only be active for one organization at a time.
 */

export const DOMAIN_STATUSES = ["pending_dns", "verified", "active", "removed"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export const DOMAIN_STATUS_LABELS: Record<DomainStatus, string> = {
  pending_dns: "Awaiting DNS verification",
  verified: "Verified — ready to activate",
  active: "Active",
  removed: "Removed",
};

export const SSL_STATUSES = ["not_provisioned", "pending", "issued"] as const;
export type SslStatus = (typeof SSL_STATUSES)[number];

const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Normalizes user input ("https://Portal.Acme.com/") to a bare lowercase
 * hostname, or returns null when it is not a plausible custom domain.
 * Wildcards, IPs, localhost, and single-label hosts are rejected.
 */
export function normalizeDomain(input: string): string | null {
  let host = (input ?? "").trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  host = host.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  host = host.replace(/\.+$/, "");
  if (!host || host.length > 253) return null;
  if (host.includes("*")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null; // IPv4
  const labels = host.split(".");
  if (labels.length < 2) return null; // must have a dot (no bare TLD/localhost)
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return host;
}

/** DNS name that must carry the verification TXT record. */
export function verificationRecordName(domain: string): string {
  return `_mogulforge-verify.${domain}`;
}

export type DnsRecord = { type: "TXT" | "CNAME"; name: string; value: string; purpose: string };

/** The DNS records the client must create for verification + routing. */
export function requiredDnsRecords(domain: string, verificationToken: string, cnameTarget: string): DnsRecord[] {
  return [
    {
      type: "TXT",
      name: verificationRecordName(domain),
      value: `mogulforge-verify=${verificationToken}`,
      purpose: "Proves you control this domain (checked during verification).",
    },
    {
      type: "CNAME",
      name: domain,
      value: cnameTarget,
      purpose: "Points the domain at your MogulForge portal (routing/SSL are completed manually by MogulForge after activation).",
    },
  ];
}

/** True when a TXT lookup result contains the expected verification value. */
export function txtRecordsContainToken(records: string[][], verificationToken: string): boolean {
  const expected = `mogulforge-verify=${verificationToken}`;
  return records.some((chunks) => chunks.join("").trim() === expected);
}

export type ActivationCheckInput = {
  status: string;
  domain: string;
};

/**
 * Activation gate: only verified domains can be activated, and only when no
 * other organization already has the same domain active.
 */
export function canActivateDomain(
  record: ActivationCheckInput,
  otherActiveDomains: string[],
): { ok: boolean; reason: string | null } {
  if (record.status === "active") return { ok: false, reason: "This domain is already active." };
  if (record.status !== "verified") {
    return { ok: false, reason: "The domain must pass DNS verification before it can be activated." };
  }
  const domain = record.domain.toLowerCase();
  if (otherActiveDomains.some((other) => other.toLowerCase() === domain)) {
    return { ok: false, reason: "This domain is already active for another organization." };
  }
  return { ok: true, reason: null };
}
