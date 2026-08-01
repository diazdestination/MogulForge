"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

type DashboardBranding = {
  displayName: string;
  logoUrl: string | null;
  primaryColor: string | null;
  portalTitle: string | null;
  supportEmail: string | null;
  poweredBy: { show: boolean; label: string };
  level: string;
};

/**
 * Client-branded header strip for the Revenue Rescue dashboard. Renders nothing
 * for the default MogulForge level; for powered_by / white_label it shows the
 * client's logo, portal title, and (when required) the powered-by attribution.
 */
export function RescueBrandingBar() {
  const searchParams = useSearchParams();
  const org = searchParams.get("org");
  const [branding, setBranding] = useState<DashboardBranding | null>(null);

  useEffect(() => {
    const query = org ? `?org=${encodeURIComponent(org)}` : "";
    fetch(`/api/dashboard/branding${query}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setBranding(body?.branding ?? null))
      .catch(() => setBranding(null));
  }, [org]);

  if (!branding || branding.level === "mogulforge") return null;

  return (
    <div className="shell pt-6">
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-3"
        style={branding.primaryColor ? { borderColor: `${branding.primaryColor}66` } : undefined}
      >
        <div className="flex items-center gap-3">
          {branding.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- client-hosted logo, unknown host
            <img src={branding.logoUrl} alt="" className="h-7 w-auto" />
          )}
          <div>
            <p className="text-sm font-extrabold" style={branding.primaryColor ? { color: branding.primaryColor } : undefined}>
              {branding.portalTitle ?? branding.displayName}
            </p>
            {branding.supportEmail && <p className="text-[11px] text-white/40">Support: {branding.supportEmail}</p>}
          </div>
        </div>
        {branding.poweredBy.show && (
          <span className="text-[10px] uppercase tracking-wider text-white/40">{branding.poweredBy.label}</span>
        )}
      </div>
    </div>
  );
}
