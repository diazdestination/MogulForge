/**
 * Custom-domain validation + DNS/activation rules — pure module (unit-testable).
 *
 * MogulForge stores and verifies domain requests. Once a domain is ACTIVE the
 * app routes it live: requests whose Host header matches an active domain
 * resolve to the owning org and render its branded portal/login. SSL
 * certificates are provisioned by the hosting platform (on Replit, by adding
 * the domain to the deployment) — ssl_status is confirmed from real HTTPS
 * traffic, never assumed. Activation is gated: never before verification, and
 * a domain can only be active for one organization at a time.
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
      purpose: "Points the domain at your MogulForge portal. Routing goes live automatically once the domain is activated; SSL certificates are provisioned by the hosting platform.",
    },
  ];
}

/** True when a TXT lookup result contains the expected verification value. */
export function txtRecordsContainToken(records: string[][], verificationToken: string): boolean {
  const expected = `mogulforge-verify=${verificationToken}`;
  return records.some((chunks) => chunks.join("").trim() === expected);
}

/**
 * Normalizes a raw Host / X-Forwarded-Host header value to a bare lowercase
 * hostname (first value if comma-separated, port stripped), or null when the
 * header is missing or an address literal that can never be a custom domain.
 */
export function normalizeHostHeader(hostHeader: string | null | undefined): string | null {
  const raw = (hostHeader ?? "").split(",")[0].trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("[")) return null; // IPv6 literal
  const host = raw.split(":")[0].replace(/\.+$/, "");
  return host || null;
}

/** Platform hostnames from env: Replit domains + the CNAME target itself. */
export function platformHostsFromEnv(env: Record<string, string | undefined>): string[] {
  return [
    ...(env.REPLIT_DOMAINS ?? "").split(","),
    env.REPLIT_DEV_DOMAIN ?? "",
    env.CUSTOM_DOMAIN_CNAME_TARGET ?? "",
  ]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * True when the request host is the platform's own host (never a client's
 * custom domain): localhost/loopback, Replit-owned domains, or one of the
 * configured platform hostnames.
 */
export function isPlatformHost(host: string, platformHosts: string[]): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // raw IPs are never custom domains
  if (h.endsWith(".replit.dev") || h.endsWith(".replit.app") || h.endsWith(".repl.co") || h.endsWith(".replit.com")) return true;
  return platformHosts.some((p) => p === h);
}

/**
 * True when a CNAME lookup result points at the platform target
 * (case-insensitive, trailing dots ignored).
 */
export function cnameMatchesTarget(records: string[], target: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\.+$/, "");
  const expected = normalize(target);
  if (!expected) return false;
  return records.some((record) => normalize(record) === expected);
}

export type GoLiveStep = { key: "dns_verified" | "activated" | "certificate" | "https"; label: string; done: boolean; detail: string | null };

/**
 * Go-live checklist shown to clients and admins: DNS verified → activated
 * (routing live) → certificate setup → HTTPS confirmed. SSL is only ever
 * confirmed from real HTTPS traffic, so the last two steps flip together
 * when ssl_status reaches 'issued'.
 */
export function domainGoLiveChecklist(domain: { status: DomainStatus; sslStatus: SslStatus }): GoLiveStep[] {
  const verified = domain.status === "verified" || domain.status === "active";
  const active = domain.status === "active";
  const issued = domain.sslStatus === "issued";
  return [
    {
      key: "dns_verified",
      label: "DNS verified",
      done: verified,
      detail: verified ? null : "Add the TXT record below, then run a check.",
    },
    {
      key: "activated",
      label: "Domain activated — routing live",
      done: active,
      detail: active ? null : verified ? "MogulForge activates the domain during your scheduled cutover." : null,
    },
    {
      key: "certificate",
      label: "SSL certificate setup",
      done: issued,
      detail: issued ? null : active ? "MogulForge is finishing certificate setup." : null,
    },
    {
      key: "https",
      label: "HTTPS confirmed live",
      done: issued,
      detail: issued ? null : active ? "Confirmed automatically when the first secure request arrives on your domain." : null,
    },
  ];
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
