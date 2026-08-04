import "server-only";
import { randomBytes } from "node:crypto";
import { resolveCname, resolveTxt } from "node:dns/promises";
import { getPool } from "./db";
import {
  canActivateDomain,
  cnameMatchesTarget,
  normalizeDomain,
  requiredDnsRecords,
  txtRecordsContainToken,
  verificationRecordName,
  type DnsRecord,
  type DomainStatus,
  type SslStatus,
} from "./custom-domain-core";

/**
 * Custom-domain records: request → DNS verification → activation → live routing.
 * Active domains are routed by the app itself (host-header lookup via
 * lib/portal-host.ts); SSL certificates come from the hosting platform (add
 * the domain to the Replit deployment) and ssl_status flips to 'issued' only
 * when a real HTTPS request is observed on the domain. This module stores
 * state and enforces the gates (no activation until verified + unique).
 */

export type CustomDomain = {
  id: string;
  organizationId: string;
  domain: string;
  verificationToken: string;
  status: DomainStatus;
  sslStatus: SslStatus;
  requiredDns: DnsRecord[];
  lastCheckedAt: string | null;
  lastCheckError: string | null;
  verifiedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapDomain(row: any): CustomDomain {
  return {
    id: row.id,
    organizationId: row.organization_id,
    domain: row.domain,
    verificationToken: row.verification_token,
    status: row.status,
    sslStatus: row.ssl_status,
    requiredDns: (row.required_dns ?? []) as DnsRecord[],
    lastCheckedAt: row.last_checked_at ? new Date(row.last_checked_at).toISOString() : null,
    lastCheckError: row.last_check_error ?? null,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
    activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** CNAME target shown in the required DNS records (platform-dependent). */
function cnameTarget(): string {
  return process.env.CUSTOM_DOMAIN_CNAME_TARGET ?? process.env.REPLIT_DOMAINS?.split(",")[0]?.trim() ?? "your-mogulforge-portal.example.com";
}

export async function listCustomDomains(organizationId: string): Promise<CustomDomain[]> {
  const { rows } = await getPool().query(
    "SELECT * FROM custom_domains WHERE organization_id = $1 AND status <> 'removed' ORDER BY created_at DESC",
    [organizationId],
  );
  return rows.map(mapDomain);
}

export async function getCustomDomain(organizationId: string, domainId: string): Promise<CustomDomain | null> {
  const { rows } = await getPool().query("SELECT * FROM custom_domains WHERE organization_id = $1 AND id = $2", [organizationId, domainId]);
  return rows[0] ? mapDomain(rows[0]) : null;
}

/** All custom domains across orgs (admin console). */
export async function listAllCustomDomains(): Promise<(CustomDomain & { organizationName: string })[]> {
  const { rows } = await getPool().query(
    `SELECT d.*, o.name AS organization_name FROM custom_domains d
     JOIN organizations o ON o.id = d.organization_id
     WHERE d.status <> 'removed' ORDER BY d.created_at DESC`,
  );
  return rows.map((row) => ({ ...mapDomain(row), organizationName: row.organization_name }));
}

/**
 * Host-header routing lookup: only ACTIVE domains ever resolve. Verified-but-
 * not-activated, pending, and removed domains return null (they never route).
 */
export async function findActiveCustomDomainByHost(host: string): Promise<CustomDomain | null> {
  const { rows } = await getPool().query(
    "SELECT * FROM custom_domains WHERE lower(domain) = $1 AND status = 'active' LIMIT 1",
    [host.toLowerCase()],
  );
  return rows[0] ? mapDomain(rows[0]) : null;
}

/**
 * Records SSL as issued from observed traffic: a real HTTPS request arriving
 * on the active domain proves the platform certificate is live. No-op unless
 * the domain is still active and not already marked issued.
 */
export async function markDomainSslIssuedFromTraffic(domainId: string): Promise<void> {
  await getPool().query(
    "UPDATE custom_domains SET ssl_status = 'issued', updated_at = now() WHERE id = $1 AND status = 'active' AND ssl_status <> 'issued'",
    [domainId],
  );
}

/**
 * Base URL for links in org-facing emails: the org's active (verified +
 * routed) custom domain when one exists, otherwise the platform SITE_URL.
 * Returns an origin with no trailing slash, e.g. "https://portal.client.com".
 * Alert emails should build their links from this so they land on the org's
 * branded portal (matching the login session the client actually uses).
 */
export async function getOrgPortalBaseUrl(organizationId: string): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT domain FROM custom_domains
     WHERE organization_id = $1 AND status = 'active'
     ORDER BY activated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [organizationId],
  );
  if (rows[0]?.domain) return `https://${String(rows[0].domain).toLowerCase()}`;
  const { SITE_URL } = await import("./site");
  return SITE_URL;
}

export class DomainRequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Creates a domain request with a fresh verification token + required DNS records. */
export async function requestCustomDomain(organizationId: string, rawDomain: string): Promise<CustomDomain> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) throw new DomainRequestError("Enter a valid domain like portal.yourcompany.com.");

  const { rows: existing } = await getPool().query(
    "SELECT organization_id FROM custom_domains WHERE lower(domain) = $1 AND status <> 'removed'",
    [domain],
  );
  if (existing[0]) {
    throw new DomainRequestError(
      existing[0].organization_id === organizationId
        ? "This domain has already been requested for your organization."
        : "This domain is already claimed by another organization.",
      409,
    );
  }

  const token = randomBytes(18).toString("base64url");
  const dns = requiredDnsRecords(domain, token, cnameTarget());
  try {
    const { rows } = await getPool().query(
      `INSERT INTO custom_domains (organization_id, domain, verification_token, required_dns)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [organizationId, domain, token, JSON.stringify(dns)],
    );
    return mapDomain(rows[0]);
  } catch (error) {
    // Unique-index race: another request claimed the domain between check and insert.
    if (error instanceof Error && "code" in error && (error as { code?: string }).code === "23505") {
      throw new DomainRequestError("This domain is already claimed by another organization.", 409);
    }
    throw error;
  }
}

export type VerifyResult = { verified: boolean; error: string | null; domain: CustomDomain };

/**
 * Attempts DNS TXT verification. Failure is recorded, never thrown — the
 * client can retry after fixing DNS. Admins may force-verify (manual review).
 */
export async function verifyCustomDomain(organizationId: string, domainId: string, options: { force?: boolean } = {}): Promise<VerifyResult | null> {
  const record = await getCustomDomain(organizationId, domainId);
  if (!record || record.status === "removed") return null;
  if (record.status === "verified" || record.status === "active") return { verified: true, error: null, domain: record };

  let verified = !!options.force;
  let checkError: string | null = null;
  if (!verified) {
    try {
      const txt = await resolveTxt(verificationRecordName(record.domain));
      verified = txtRecordsContainToken(txt, record.verificationToken);
      if (!verified) checkError = "The TXT record exists but does not contain the expected verification value.";
    } catch (error) {
      checkError = `TXT record not found yet (${error instanceof Error && "code" in error ? (error as { code?: string }).code : "lookup failed"}). DNS changes can take up to an hour to propagate.`;
    }
  }

  const { rows } = await getPool().query(
    `UPDATE custom_domains SET
       status = CASE WHEN $3 THEN 'verified' ELSE status END,
       verified_at = CASE WHEN $3 THEN now() ELSE verified_at END,
       last_checked_at = now(), last_check_error = $4, updated_at = now()
     WHERE organization_id = $1 AND id = $2 RETURNING *`,
    [organizationId, domainId, verified, verified ? null : checkError],
  );
  return { verified, error: verified ? null : checkError, domain: mapDomain(rows[0]) };
}

export type DomainCheckResult = {
  verified: boolean;
  /** True only when this check flipped the domain from pending to verified. */
  newlyVerified: boolean;
  cnameOk: boolean;
  message: string;
  domain: CustomDomain;
};

/**
 * "Check now" probe: re-runs TXT verification when the domain is still
 * pending, and checks whether the domain's CNAME points at the platform
 * target. Failures are recorded on the record (last_check_error), never
 * thrown — the client can fix DNS and retry.
 */
export async function checkCustomDomain(organizationId: string, domainId: string): Promise<DomainCheckResult | null> {
  const before = await getCustomDomain(organizationId, domainId);
  if (!before || before.status === "removed") return null;
  const verifyResult = await verifyCustomDomain(organizationId, domainId);
  if (!verifyResult) return null;
  let record = verifyResult.domain;
  const newlyVerified = before.status === "pending_dns" && verifyResult.verified;

  const target = cnameTarget();
  let cnameOk = false;
  let cnameError: string | null = null;
  try {
    const records = await resolveCname(record.domain);
    cnameOk = cnameMatchesTarget(records, target);
    if (!cnameOk) cnameError = `The CNAME record points at ${records.join(", ") || "nothing"} instead of ${target}.`;
  } catch {
    cnameError = `No CNAME record found for ${record.domain} yet. Add a CNAME pointing at ${target} — DNS changes can take up to an hour to propagate.`;
  }

  const combinedError = [verifyResult.verified ? null : verifyResult.error, cnameError].filter(Boolean).join(" ") || null;
  const { rows } = await getPool().query(
    "UPDATE custom_domains SET last_checked_at = now(), last_check_error = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *",
    [organizationId, domainId, combinedError],
  );
  if (rows[0]) record = mapDomain(rows[0]);

  const message = combinedError
    ?? (record.status === "active"
      ? `Routing is live and the CNAME points at ${target}.`
      : `Domain verified and the CNAME points at ${target}.`);
  return { verified: verifyResult.verified, newlyVerified, cnameOk, message, domain: record };
}

/**
 * Activates a verified domain. Gated: refuses unverified domains and domains
 * already active for another org. Activation makes in-app routing live
 * immediately; ssl_status moves to 'pending' until the first HTTPS request is
 * observed on the domain (certificates are provisioned by adding the domain
 * to the Replit deployment — see the runbook in replit.md).
 */
export async function activateCustomDomain(organizationId: string, domainId: string): Promise<{ ok: boolean; reason: string | null; domain: CustomDomain | null }> {
  const record = await getCustomDomain(organizationId, domainId);
  if (!record || record.status === "removed") return { ok: false, reason: "Domain not found.", domain: null };

  const { rows: others } = await getPool().query(
    "SELECT domain FROM custom_domains WHERE status = 'active' AND id <> $1",
    [domainId],
  );
  const gate = canActivateDomain(record, others.map((row) => String(row.domain)));
  if (!gate.ok) return { ok: false, reason: gate.reason, domain: record };

  const { rows } = await getPool().query(
    `UPDATE custom_domains SET status = 'active', ssl_status = 'pending', activated_at = now(), updated_at = now()
     WHERE organization_id = $1 AND id = $2 AND status = 'verified' RETURNING *`,
    [organizationId, domainId],
  );
  if (!rows[0]) return { ok: false, reason: "The domain must pass DNS verification before it can be activated.", domain: record };
  return { ok: true, reason: null, domain: mapDomain(rows[0]) };
}

/** Marks SSL as issued (recorded by an admin after the manual provisioning step). */
export async function setDomainSslStatus(organizationId: string, domainId: string, sslStatus: SslStatus): Promise<CustomDomain | null> {
  const { rows } = await getPool().query(
    "UPDATE custom_domains SET ssl_status = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *",
    [organizationId, domainId, sslStatus],
  );
  return rows[0] ? mapDomain(rows[0]) : null;
}

/** Soft-removes a domain record (frees the domain for future claims). */
export async function removeCustomDomain(organizationId: string, domainId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    "UPDATE custom_domains SET status = 'removed', updated_at = now() WHERE organization_id = $1 AND id = $2 AND status <> 'removed'",
    [organizationId, domainId],
  );
  return (rowCount ?? 0) > 0;
}
