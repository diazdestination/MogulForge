/**
 * Embed theming — pure module (unit-testable, no server-only imports).
 *
 * Clients can brand the embedded widget/dashboard two ways, merged in order:
 *   1. Org-level defaults saved on Integrations → Embeds (stored jsonb).
 *   2. Per-mount overrides passed through the loader (`theme` option or
 *      data-rr-* attributes), which travel as validated iframe query params.
 *
 * Everything is normalized through this module — only hex colors, an enum of
 * radii, and https logo URLs survive, so no arbitrary CSS can be injected.
 */

export const EMBED_THEME_MODES = ["dark", "light"] as const;
export type EmbedThemeMode = (typeof EMBED_THEME_MODES)[number];

export const EMBED_THEME_RADII = ["none", "sm", "md", "lg", "xl"] as const;
export type EmbedThemeRadius = (typeof EMBED_THEME_RADII)[number];

export type EmbedTheme = {
  mode: EmbedThemeMode;
  /** Accent (buttons, bars, highlights) — hex or null to inherit org brand color. */
  accentColor: string | null;
  /** Widget background — hex or null for the mode's default (dark: transparent-on-dark, light: white). */
  backgroundColor: string | null;
  radius: EmbedThemeRadius;
  /** Optional logo shown in embed headers — https URL or null to inherit the org logo. */
  logoUrl: string | null;
};

export const DEFAULT_EMBED_THEME: EmbedTheme = {
  mode: "dark",
  accentColor: null,
  backgroundColor: null,
  radius: "lg",
  logoUrl: null,
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isEmbedHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

function color(value: unknown, fallback: string | null): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return HEX_RE.test(trimmed) ? trimmed : fallback;
}

function logo(value: unknown, fallback: string | null): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().slice(0, 500);
  return /^https:\/\/[^\s"'<>]+$/i.test(trimmed) ? trimmed : fallback;
}

/**
 * Normalizes an arbitrary stored/submitted blob into a full EmbedTheme,
 * merging over `base`. Unknown keys are dropped; invalid values fall back to
 * the base value — never to garbage.
 */
export function normalizeEmbedTheme(raw: unknown, base: EmbedTheme = DEFAULT_EMBED_THEME): EmbedTheme {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    mode: (EMBED_THEME_MODES as readonly string[]).includes(String(root.mode)) ? (root.mode as EmbedThemeMode) : base.mode,
    accentColor: root.accentColor === undefined ? base.accentColor : color(root.accentColor, base.accentColor),
    backgroundColor: root.backgroundColor === undefined ? base.backgroundColor : color(root.backgroundColor, base.backgroundColor),
    radius: (EMBED_THEME_RADII as readonly string[]).includes(String(root.radius)) ? (root.radius as EmbedThemeRadius) : base.radius,
    logoUrl: root.logoUrl === undefined ? base.logoUrl : logo(root.logoUrl, base.logoUrl),
  };
}

/** Query-param names the loader uses to pass per-mount overrides into the iframe. */
export const THEME_PARAM_KEYS = {
  mode: "t_mode",
  accentColor: "t_accent",
  backgroundColor: "t_bg",
  radius: "t_radius",
  logoUrl: "t_logo",
} as const;

/**
 * Reads per-mount theme overrides from iframe query params. Returns only the
 * keys that are present AND valid — everything else is ignored, so a hostile
 * query string can never smuggle CSS.
 */
export function themeOverridesFromParams(get: (key: string) => string | null): Partial<EmbedTheme> {
  const overrides: Partial<EmbedTheme> = {};
  const mode = get(THEME_PARAM_KEYS.mode);
  if (mode && (EMBED_THEME_MODES as readonly string[]).includes(mode)) overrides.mode = mode as EmbedThemeMode;
  const accent = get(THEME_PARAM_KEYS.accentColor);
  if (accent && HEX_RE.test(accent)) overrides.accentColor = accent;
  const bg = get(THEME_PARAM_KEYS.backgroundColor);
  if (bg && HEX_RE.test(bg)) overrides.backgroundColor = bg;
  const radius = get(THEME_PARAM_KEYS.radius);
  if (radius && (EMBED_THEME_RADII as readonly string[]).includes(radius)) overrides.radius = radius as EmbedThemeRadius;
  const logoUrl = get(THEME_PARAM_KEYS.logoUrl);
  if (logoUrl && /^https:\/\/[^\s"'<>]+$/i.test(logoUrl) && logoUrl.length <= 500) overrides.logoUrl = logoUrl;
  return overrides;
}

/** Merges per-mount overrides over the org default theme. */
export function mergeEmbedTheme(base: EmbedTheme, overrides: Partial<EmbedTheme>): EmbedTheme {
  return {
    mode: overrides.mode ?? base.mode,
    accentColor: overrides.accentColor ?? base.accentColor,
    backgroundColor: overrides.backgroundColor ?? base.backgroundColor,
    radius: overrides.radius ?? base.radius,
    logoUrl: overrides.logoUrl ?? base.logoUrl,
  };
}

export const RADIUS_PX: Record<EmbedThemeRadius, { card: number; control: number }> = {
  none: { card: 0, control: 0 },
  sm: { card: 6, control: 4 },
  md: { card: 10, control: 6 },
  lg: { card: 16, control: 8 },
  xl: { card: 24, control: 12 },
};
