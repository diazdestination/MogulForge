import "server-only";
import { getEntitlement, getOrganizationById, updateOrganization, type Organization } from "./tenant";
import { isBrandingLevel, isHexColor, resolveBranding, type EffectiveBranding } from "./branding-core";

/**
 * Server-side branding resolution + updates. The effective branding an org's
 * dashboard/embeds get is ALWAYS resolved here — the white_label entitlement
 * check happens in resolveBranding, never trusted from stored fields alone.
 */

export async function getEffectiveBranding(organizationId: string): Promise<EffectiveBranding | null> {
  const org = await getOrganizationById(organizationId);
  if (!org) return null;
  return resolveOrgBranding(org);
}

/** Resolves branding for an already-loaded org (one extra entitlement query). */
export async function resolveOrgBranding(org: Organization): Promise<EffectiveBranding> {
  const entitlement = await getEntitlement(org.id, "white_label");
  return resolveBranding(org, !!entitlement?.enabled);
}

/** Compact branding payload for embed API responses (safe for third-party pages). */
export type EmbedBranding = {
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  poweredBy: { show: boolean; label: string };
};

export async function getEmbedBranding(org: Organization): Promise<EmbedBranding> {
  const branding = await resolveOrgBranding(org);
  return {
    displayName: branding.displayName,
    logoUrl: branding.logoUrl,
    primaryColor: branding.primaryColor,
    poweredBy: branding.poweredBy,
  };
}

export type BrandingPatch = {
  brandingLevel?: string;
  displayName?: string | null;
  logoUrl?: string | null;
  brandPrimaryColor?: string | null;
  brandSecondaryColor?: string | null;
  portalTitle?: string | null;
  loginTitle?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  emailSenderName?: string | null;
  smsSenderName?: string | null;
  poweredByLabel?: string | null;
};

export class BrandingValidationError extends Error {}

function cleanField(value: string | null | undefined, max: number): string | null {
  const trimmed = (value ?? "").trim().slice(0, max);
  return trimmed === "" ? null : trimmed;
}

/**
 * Validates + persists branding settings. Storing a white_label level is
 * allowed even without the entitlement — enforcement happens on resolution,
 * so granting the entitlement later applies the stored settings instantly.
 */
export async function updateOrgBranding(organizationId: string, patch: BrandingPatch): Promise<EffectiveBranding> {
  const update: Parameters<typeof updateOrganization>[1] = {};
  if (patch.brandingLevel !== undefined) {
    if (!isBrandingLevel(patch.brandingLevel)) throw new BrandingValidationError("Unknown branding level.");
    update.brandingLevel = patch.brandingLevel;
  }
  for (const color of ["brandPrimaryColor", "brandSecondaryColor"] as const) {
    if (patch[color] !== undefined) {
      const value = cleanField(patch[color], 9);
      if (value !== null && !isHexColor(value)) throw new BrandingValidationError("Colors must be hex values like #1A2B3C.");
      update[color] = value;
    }
  }
  if (patch.logoUrl !== undefined) {
    const value = cleanField(patch.logoUrl, 500);
    if (value !== null && !/^https:\/\//i.test(value)) throw new BrandingValidationError("Logo URL must start with https://");
    update.logoUrl = value;
  }
  if (patch.supportEmail !== undefined) {
    const value = cleanField(patch.supportEmail, 320);
    if (value !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new BrandingValidationError("Support email is not a valid email address.");
    update.supportEmail = value;
  }
  if (patch.displayName !== undefined) update.displayName = cleanField(patch.displayName, 120);
  if (patch.portalTitle !== undefined) update.portalTitle = cleanField(patch.portalTitle, 160);
  if (patch.loginTitle !== undefined) update.loginTitle = cleanField(patch.loginTitle, 160);
  if (patch.supportPhone !== undefined) update.supportPhone = cleanField(patch.supportPhone, 40);
  if (patch.emailSenderName !== undefined) update.emailSenderName = cleanField(patch.emailSenderName, 120);
  if (patch.smsSenderName !== undefined) update.smsSenderName = cleanField(patch.smsSenderName, 60);
  if (patch.poweredByLabel !== undefined) update.poweredByLabel = cleanField(patch.poweredByLabel, 120);

  const org = await updateOrganization(organizationId, update);
  if (!org) throw new BrandingValidationError("Organization not found.");
  return resolveOrgBranding(org);
}
