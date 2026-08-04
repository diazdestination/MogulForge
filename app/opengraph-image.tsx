import { ImageResponse } from "next/og";
import { BRAND, SITE_NAME } from "@/lib/site";
import { getPortalHostContext } from "@/lib/portal-host";

export const alt = "MogulForge — Stop losing revenue you already earned.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Host-aware OG image: platform hosts keep the MogulForge card; custom-domain
 * portal hosts get a card built from the org's own branding (logo, colors,
 * name) so link previews never leak the platform brand on a white-label domain.
 */
/**
 * Satori needs explicit dimensions and a fetchable image; a broken or
 * dimension-less logo URL must degrade to a text-only card, never a 500.
 */
async function fetchLogoDataUrl(logoUrl: string): Promise<string | null> {
  try {
    const res = await fetch(logoUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!type.startsWith("image/") || type === "image/svg+xml") return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 4 * 1024 * 1024) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function OpenGraphImage() {
  const context = await getPortalHostContext();

  if (context.kind === "portal") {
    const { branding } = context;
    const bg = branding.primaryColor ?? BRAND.ink;
    const accent = branding.secondaryColor ?? BRAND.cream;
    const logoSrc = branding.logoUrl ? await fetchLogoDataUrl(branding.logoUrl) : null;
    return new ImageResponse(
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 32,
          padding: "64px 72px",
          backgroundColor: bg,
          color: accent,
          fontFamily: "sans-serif",
        }}
      >
        {logoSrc ? (
          <img src={logoSrc} alt="" width={160} height={160} style={{ objectFit: "contain" }} />
        ) : null}
        <div style={{ display: "flex", fontSize: 72, fontWeight: 800, textAlign: "center" }}>{branding.displayName}</div>
        <div style={{ display: "flex", fontSize: 30, opacity: 0.8 }}>{branding.portalTitle}</div>
        {branding.poweredBy.show ? (
          <div style={{ display: "flex", fontSize: 22, opacity: 0.6 }}>{branding.poweredBy.label}</div>
        ) : null}
      </div>,
      size,
    );
  }

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 72px",
        backgroundColor: BRAND.ink,
        backgroundImage: `linear-gradient(rgba(243,240,232,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(243,240,232,0.045) 1px, transparent 1px)`,
        backgroundSize: "72px 72px",
        color: BRAND.cream,
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 64,
            height: 64,
            borderRadius: 999,
            border: `3px solid ${BRAND.lime}`,
            color: BRAND.lime,
            fontSize: 26,
            fontWeight: 800,
          }}
        >
          MF
        </div>
        <div style={{ display: "flex", fontSize: 34, fontWeight: 800, letterSpacing: 2 }}>{SITE_NAME.toUpperCase()}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", fontSize: 22, fontWeight: 700, letterSpacing: 6, color: BRAND.lime }}>
          INTRODUCING AI REVENUE RESCUE™
        </div>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 84, fontWeight: 700, lineHeight: 1.02 }}>
          <span>Stop losing revenue</span>
          <span style={{ display: "flex" }}>
            <span style={{ color: BRAND.lime }}>you already earned.</span>
          </span>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", fontSize: 24, color: "rgba(243,240,232,0.65)" }}>
          Lead recovery · AI visibility · Conversion systems
        </div>
        <div
          style={{
            display: "flex",
            padding: "14px 28px",
            borderRadius: 999,
            backgroundColor: BRAND.lime,
            color: BRAND.ink,
            fontSize: 24,
            fontWeight: 800,
          }}
        >
          Run the scan
        </div>
      </div>
    </div>,
    size,
  );
}
