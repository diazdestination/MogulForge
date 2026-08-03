import {
  DEFAULT_EMBED_THEME,
  mergeEmbedTheme,
  normalizeEmbedTheme,
  RADIUS_PX,
  themeOverridesFromParams,
  type EmbedTheme,
} from "@/lib/embed/theme-core";

/** Client-side shape of the branding payload returned by the embed APIs. */
export type EmbedBranding = {
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  poweredBy: { show: boolean; label: string };
  theme: EmbedTheme;
};

const DEFAULT_BRANDING: EmbedBranding = {
  displayName: "",
  logoUrl: null,
  primaryColor: null,
  poweredBy: { show: true, label: "Powered by MogulForge" },
  theme: DEFAULT_EMBED_THEME,
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
    theme: normalizeEmbedTheme((raw as { theme?: unknown }).theme),
  };
}

/**
 * Resolves the effective theme for an embed page: org defaults from the
 * branding payload, then validated per-mount overrides from the iframe query
 * string (passed through by the loader).
 */
export function resolveEmbedTheme(branding: EmbedBranding | null, searchParams: { get(key: string): string | null }): EmbedTheme {
  const base = branding?.theme ?? DEFAULT_EMBED_THEME;
  return mergeEmbedTheme(base, themeOverridesFromParams((key) => searchParams.get(key)));
}

/** Effective logo for embed headers: per-theme logo wins, then the org brand logo. */
export function themeLogoUrl(theme: EmbedTheme, branding: EmbedBranding | null): string | null {
  return theme.logoUrl ?? branding?.logoUrl ?? null;
}

/** Inline styles derived from a theme — Tailwind colors are static, so theming must be inline. */
export type EmbedStyles = {
  root: React.CSSProperties;
  card: React.CSSProperties;
  input: React.CSSProperties;
  /** Solid accent element (primary button, funnel bar). */
  accentSolid: React.CSSProperties;
  /** Soft accent track/badge background. */
  accentSoft: React.CSSProperties;
  heading: React.CSSProperties;
  muted: React.CSSProperties;
  faint: React.CSSProperties;
  controlRadius: React.CSSProperties;
  error: React.CSSProperties;
};

const DARK_ACCENT_FALLBACK = "#c8f31d"; // forge-lime
const LIGHT_ACCENT_FALLBACK = "#4f7c0a";

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  let value = m[1];
  if (value.length === 3) value = value.split("").map((c) => c + c).join("");
  const n = parseInt(value, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Black or white text, whichever contrasts better with the given background. */
export function contrastText(background: string): string {
  const rgb = hexToRgb(background);
  if (!rgb) return "#000000";
  const [r, g, b] = rgb;
  return 0.299 * r + 0.587 * g + 0.114 * b > 145 ? "#000000" : "#ffffff";
}

/** Computes all inline style objects the embed components need from a theme. */
export function embedStyles(theme: EmbedTheme, branding: EmbedBranding | null): EmbedStyles {
  const dark = theme.mode === "dark";
  const accent = theme.accentColor ?? branding?.primaryColor ?? (dark ? DARK_ACCENT_FALLBACK : LIGHT_ACCENT_FALLBACK);
  const background = theme.backgroundColor ?? (dark ? "#0b0e11" : "#ffffff");
  const radius = RADIUS_PX[theme.radius];
  const text = dark ? "#ffffff" : "#111418";
  const border = dark ? "rgba(255,255,255,0.12)" : "rgba(17,20,24,0.14)";
  return {
    root: { backgroundColor: background, color: text },
    card: {
      border: `1px solid ${border}`,
      backgroundColor: dark ? "rgba(255,255,255,0.03)" : "rgba(17,20,24,0.025)",
      borderRadius: radius.card,
    },
    input: {
      border: `1px solid ${dark ? "rgba(255,255,255,0.15)" : "rgba(17,20,24,0.2)"}`,
      backgroundColor: dark ? "rgba(0,0,0,0.4)" : "#ffffff",
      color: text,
      borderRadius: radius.control,
    },
    accentSolid: { backgroundColor: accent, color: contrastText(accent), borderRadius: radius.control },
    accentSoft: { backgroundColor: accent + "26", color: accent, borderRadius: radius.control },
    heading: { color: text },
    muted: { color: dark ? "rgba(255,255,255,0.55)" : "rgba(17,20,24,0.6)" },
    faint: { color: dark ? "rgba(255,255,255,0.38)" : "rgba(17,20,24,0.45)" },
    controlRadius: { borderRadius: radius.control },
    error: { color: dark ? "#fca5a5" : "#b91c1c" },
  };
}

/** Styles for the default (no branding yet loaded) dark shell. */
export const DEFAULT_EMBED_STYLES: EmbedStyles = embedStyles(DEFAULT_EMBED_THEME, null);
