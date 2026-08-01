import { ImageResponse } from "next/og";
import { getVisibilityReport, reportHost } from "@/lib/report-lookup";
import { BRAND, SITE_NAME } from "@/lib/site";

export const alt = "AI Visibility Score report by MogulForge";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

function scoreColor(score: number) {
  if (score >= 80) return BRAND.lime;
  if (score >= 55) return "#f0c94e";
  return BRAND.rust;
}

export default async function ReportOpenGraphImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await getVisibilityReport(id);
  const score = row ? Number(row.score) : null;
  const host = row ? reportHost(row.url) : "";
  const accent = score === null ? BRAND.lime : scoreColor(score);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "64px 72px",
        backgroundColor: BRAND.ink,
        backgroundImage: `linear-gradient(rgba(243,240,232,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(243,240,232,0.045) 1px, transparent 1px)`,
        backgroundSize: "72px 72px",
        color: BRAND.cream,
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 640 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 52,
              height: 52,
              borderRadius: 999,
              border: `3px solid ${BRAND.lime}`,
              color: BRAND.lime,
              fontSize: 21,
              fontWeight: 800,
            }}
          >
            MF
          </div>
          <div style={{ display: "flex", fontSize: 26, fontWeight: 800, letterSpacing: 2 }}>{SITE_NAME.toUpperCase()}</div>
        </div>
        <div style={{ display: "flex", fontSize: 20, fontWeight: 700, letterSpacing: 6, color: BRAND.lime }}>
          AI VISIBILITY REPORT
        </div>
        <div style={{ display: "flex", fontSize: 58, fontWeight: 700, lineHeight: 1.05 }}>
          {host ? `How visible is ${host} to AI search?` : "How visible is your site to AI search?"}
        </div>
        <div style={{ display: "flex", fontSize: 24, color: "rgba(243,240,232,0.65)" }}>
          Schema · Crawlability · Metadata · Content structure
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: 320,
          height: 320,
          borderRadius: 999,
          border: `6px solid ${accent}`,
          backgroundColor: "rgba(243,240,232,0.04)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <div style={{ display: "flex", fontSize: 128, fontWeight: 800, color: accent }}>{score === null ? "?" : score}</div>
          <div style={{ display: "flex", fontSize: 36, color: "rgba(243,240,232,0.6)" }}>/100</div>
        </div>
        <div style={{ display: "flex", fontSize: 22, fontWeight: 700, letterSpacing: 3, color: "rgba(243,240,232,0.7)" }}>
          VISIBILITY SCORE
        </div>
      </div>
    </div>,
    size,
  );
}
