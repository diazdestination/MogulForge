import "server-only";
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { getPool } from "./db";
import {
  canActivateDomain,
  normalizeDomain,
  requiredDnsRecords,
  txtRecordsContainToken,
  verificationRecordName,
  type DnsRecord,
  type DomainStatus,
  type SslStatus,
} from "./custom-domain-core";

/**
 * Custom-domain records: request → DNS verification → activation.
 * Traffic routing + SSL issuance are manual/platform-dependent — this module
 * stores state and enforces the gates (no activation until verified + unique).
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

export class DomainRequestError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
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

/**
 * Activates a verified domain. Gated: refuses unverified domains and domains
 * already active for another org. Routing/SSL completion remains a manual,
 * platform-dependent step (ssl_status moves to 'pending' for the ops runbook).
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
