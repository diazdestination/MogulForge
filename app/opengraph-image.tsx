import { ImageResponse } from "next/og";
import { BRAND, SITE_NAME } from "@/lib/site";

export const alt = "MogulForge — Stop losing revenue you already earned.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
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
