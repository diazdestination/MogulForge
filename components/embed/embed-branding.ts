/** Client-side shape of the branding payload returned by the embed APIs. */
export type EmbedBranding = {
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  poweredBy: { show: boolean; label: string };
};

const DEFAULT_BRANDING: EmbedBranding = {
  displayName: "",
  logoUrl: null,
  primaryColor: null,
  poweredBy: { show: true, label: "Powered by MogulForge" },
};

/** Parses the optional `branding` field from an embed API response body. */
export function parseEmbedBranding(body: unknown): EmbedBranding {
  if (!body || typeof body !== "object") return DEFAULT_BRANDING;
  const raw = (body as { branding?: unknown }).branding;
  if (!raw || typeof raw !== "object") return DEFAULT_BRANDING;
  const branding = raw as Partial<EmbedBranding>;
  return {
    displayName: typeof branding.displayName === "string" ? branding.displayName : "",
    logoUrl: typeof branding.logoUrl === "string" ? branding.logoUrl : null,
    primaryColor: typeof branding.primaryColor === "string" && /^#[0-9a-fA-F]{3,8}$/.test(branding.primaryColor) ? branding.primaryColor : null,
    poweredBy: branding.poweredBy && typeof branding.poweredBy === "object"
      ? { show: branding.poweredBy.show !== false, label: typeof branding.poweredBy.label === "string" ? branding.poweredBy.label : DEFAULT_BRANDING.poweredBy.label }
      : DEFAULT_BRANDING.poweredBy,
  };
}

/** Inline background override for accent elements (Tailwind theme colors are static). */
export function accentBg(branding: EmbedBranding | null): React.CSSProperties | undefined {
  return branding?.primaryColor ? { backgroundColor: branding.primaryColor } : undefined;
}

/** Inline text-color override for accent elements. */
export function accentText(branding: EmbedBranding | null): React.CSSProperties | undefined {
  return branding?.primaryColor ? { color: branding.primaryColor } : undefined;
}
