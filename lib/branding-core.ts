/**
 * Branding / white-label resolution — pure module (unit-testable).
 *
 * Three branding levels:
 *   mogulforge  — standard MogulForge-branded portal (client colors/logo ignored)
 *   powered_by  — client brand applied + a mandatory "Powered by MogulForge" line
 *   white_label — full white label; requires the white_label entitlement and is
 *                 downgraded to powered_by server-side when it is missing.
 */

export const BRANDING_LEVELS = ["mogulforge", "powered_by", "white_label"] as const;
export type BrandingLevel = (typeof BRANDING_LEVELS)[number];

export const BRANDING_LEVEL_LABELS: Record<BrandingLevel, string> = {
  mogulforge: "MogulForge branded",
  powered_by: "Powered by MogulForge",
  white_label: "Full white label",
};

export function isBrandingLevel(value: string): value is BrandingLevel {
  return (BRANDING_LEVELS as readonly string[]).includes(value);
}

export type OrgBrandingFields = {
  name: string;
  brandingLevel: string;
  displayName: string | null;
  logoUrl: string | null;
  brandPrimaryColor: string | null;
  brandSecondaryColor: string | null;
  portalTitle: string | null;
  loginTitle: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  emailSenderName: string | null;
  smsSenderName: string | null;
  poweredByLabel: string | null;
};

export type EffectiveBranding = {
  /** Enforced level after the entitlement check. */
  level: BrandingLevel;
  /** The level the org asked for (may exceed what it is entitled to). */
  requestedLevel: BrandingLevel;
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  portalTitle: string;
  loginTitle: string;
  supportEmail: string | null;
  supportPhone: string | null;
  emailSenderName: string;
  smsSenderName: string;
  poweredBy: { show: boolean; label: string };
};

export function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/**
 * Resolves the branding an org's portal/embeds actually get. This is the
 * entitlement enforcement point: white_label without the entitlement enabled
 * resolves to powered_by — never trusted from the stored level alone.
 */
export function resolveBranding(org: OrgBrandingFields, whiteLabelEnabled: boolean): EffectiveBranding {
  const requestedLevel: BrandingLevel = isBrandingLevel(org.brandingLevel) ? org.brandingLevel : "mogulforge";
  let level: BrandingLevel = requestedLevel;
  if (level === "white_label" && !whiteLabelEnabled) level = "powered_by";

  const displayName = (org.displayName ?? "").trim() || org.name;

  if (level === "mogulforge") {
    return {
      level,
      requestedLevel,
      displayName: org.name,
      logoUrl: null,
      primaryColor: null,
      secondaryColor: null,
      portalTitle: `${org.name} — Revenue Rescue`,
      loginTitle: "Sign in to MogulForge",
      supportEmail: org.supportEmail,
      supportPhone: org.supportPhone,
      emailSenderName: org.name,
      smsSenderName: org.name,
      poweredBy: { show: true, label: "MogulForge" },
    };
  }

  const primaryColor = org.brandPrimaryColor && isHexColor(org.brandPrimaryColor) ? org.brandPrimaryColor : null;
  const secondaryColor = org.brandSecondaryColor && isHexColor(org.brandSecondaryColor) ? org.brandSecondaryColor : null;

  return {
    level,
    requestedLevel,
    displayName,
    logoUrl: org.logoUrl,
    primaryColor,
    secondaryColor,
    portalTitle: (org.portalTitle ?? "").trim() || `${displayName} — Revenue Rescue`,
    loginTitle: (org.loginTitle ?? "").trim() || `Sign in to ${displayName}`,
    supportEmail: org.supportEmail,
    supportPhone: org.supportPhone,
    emailSenderName: (org.emailSenderName ?? "").trim() || displayName,
    smsSenderName: (org.smsSenderName ?? "").trim() || displayName,
    poweredBy:
      level === "powered_by"
        ? { show: true, label: "Powered by MogulForge" }
        : (org.poweredByLabel ?? "").trim()
          ? { show: true, label: (org.poweredByLabel as string).trim() }
          : { show: false, label: "" },
  };
}
