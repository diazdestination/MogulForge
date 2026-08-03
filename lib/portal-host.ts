import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { getOrganizationById, type Organization } from "./tenant";
import { resolveOrgBranding } from "./branding";
import type { EffectiveBranding } from "./branding-core";
import { isPlatformHost, normalizeHostHeader, platformHostsFromEnv } from "./custom-domain-core";
import { findActiveCustomDomainByHost, markDomainSslIssuedFromTraffic } from "./custom-domains";

/**
 * Host-header → organization resolution for live custom-domain portals.
 *
 * Only domains with status = 'active' (verified + admin-activated) ever
 * resolve. Pending, verified-but-not-activated, and removed domains land in
 * "unknown_domain" — they never route to any org's portal. Platform hosts
 * (Replit domains, localhost, the CNAME target) resolve to "platform".
 *
 * A real HTTPS request observed on an active domain flips ssl_status to
 * 'issued' — SSL state is confirmed from traffic, never assumed.
 */

export type PortalHostContext =
  | { kind: "platform" }
  | { kind: "unknown_domain"; host: string }
  | { kind: "portal"; host: string; org: Organization; branding: EffectiveBranding };

/** Per-request cached resolution (login page, dashboard context, portal page all share one lookup). */
export const getPortalHostContext = cache(async (): Promise<PortalHostContext> => {
  const h = await headers();
  const host = normalizeHostHeader(h.get("x-forwarded-host") ?? h.get("host"));
  if (!host || isPlatformHost(host, platformHostsFromEnv(process.env))) return { kind: "platform" };

  const domain = await findActiveCustomDomainByHost(host);
  if (!domain) return { kind: "unknown_domain", host };

  const org = await getOrganizationById(domain.organizationId);
  if (!org || org.status !== "active") return { kind: "unknown_domain", host };

  const proto = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  if (proto === "https" && domain.sslStatus !== "issued") {
    await markDomainSslIssuedFromTraffic(domain.id);
  }

  const branding = await resolveOrgBranding(org);
  return { kind: "portal", host, org, branding };
});
