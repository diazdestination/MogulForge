import Link from "next/link";
import type { EffectiveBranding } from "@/lib/branding-core";

/**
 * Minimal chrome for custom-domain portal hosts. No MogulForge marketing
 * navigation — just the owning org's brand (per resolveOrgBranding) and a slim
 * footer that honors the powered-by rules. Per-org accents must be inline
 * styles (Tailwind colors are compiled hex).
 */

export function PortalHeader({ branding }: { branding: EffectiveBranding | null }) {
  const accent = branding?.primaryColor ?? null;
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-forge-ink/85 backdrop-blur-xl">
      <div className="shell flex h-[76px] items-center justify-between">
        <Link href="/" className="flex items-center gap-3 font-extrabold tracking-tight">
          {branding?.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logoUrl} alt={`${branding.displayName} logo`} className="h-9 w-auto" />
          ) : (
            <span
              className="grid h-9 w-9 place-items-center rounded-full border border-white/30 text-xs"
              style={accent ? { borderColor: accent, color: accent } : undefined}
            >
              {(branding?.displayName ?? "Portal").slice(0, 2).toUpperCase()}
            </span>
          )}
          <span>{branding ? branding.displayName : "Client portal"}</span>
        </Link>
      </div>
    </header>
  );
}

export function PortalFooter({ branding }: { branding: EffectiveBranding | null }) {
  return (
    <footer className="border-t border-white/10 bg-black/20">
      <div className="shell flex flex-col gap-2 py-6 text-xs text-white/35 sm:flex-row sm:items-center sm:justify-between">
        <p>
          © {new Date().getFullYear()} {branding ? branding.displayName : "Client portal"}
          {branding?.supportEmail && (
            <>
              {" · "}
              <a className="hover:text-white/70" href={`mailto:${branding.supportEmail}`}>
                {branding.supportEmail}
              </a>
            </>
          )}
        </p>
        {branding?.poweredBy.show && <p>{branding.poweredBy.label}</p>}
      </div>
    </footer>
  );
}
