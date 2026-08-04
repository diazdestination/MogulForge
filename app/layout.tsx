import type { Metadata } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { PortalFooter, PortalHeader } from "@/components/portal-chrome";
import { getPortalHostContext } from "@/lib/portal-host";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
const display = Cormorant_Garamond({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });

const platformMetadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME} | ${SITE_TAGLINE}`, template: `%s | ${SITE_NAME}` },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "./" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_US",
    url: "./",
    title: { default: `${SITE_NAME} | ${SITE_TAGLINE}`, template: `%s | ${SITE_NAME}` },
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: { default: `${SITE_NAME} | ${SITE_TAGLINE}`, template: `%s | ${SITE_NAME}` },
    description: SITE_DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: SITE_NAME,
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  slogan: SITE_TAGLINE,
  knowsAbout: ["lead recovery", "AI search visibility", "revenue recovery", "conversion websites", "marketing automation"],
};

const webSiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: SITE_NAME,
  url: SITE_URL,
};

/** Deterministic short hash of the logo URL — cache-busts icons when the logo changes. */
function iconVersion(logoUrl: string): string {
  let hash = 5381;
  for (let i = 0; i < logoUrl.length; i++) hash = ((hash * 33) ^ logoUrl.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

export async function generateMetadata(): Promise<Metadata> {
  const context = await getPortalHostContext();
  if (context.kind === "portal") {
    const { branding } = context;
    return {
      title: { default: branding.portalTitle, template: `%s | ${branding.displayName}` },
      description: `${branding.displayName} client portal`,
      robots: { index: false, follow: false },
      // The client's own logo in the browser tab — never the MogulForge favicon
      // on a branded domain. Orgs without a logo get no icon rather than ours.
      // Icons go through /api/portal-icon, which serves a small square PNG
      // derivative so huge or wide logos still render crisply at tab size.
      // The `v` hash busts browser caches when the org swaps its logo.
      ...(branding.logoUrl
        ? {
            icons: {
              icon: `/api/portal-icon?size=64&v=${iconVersion(branding.logoUrl)}`,
              apple: `/api/portal-icon?size=180&v=${iconVersion(branding.logoUrl)}`,
            },
          }
        : {}),
    };
  }
  if (context.kind === "unknown_domain") {
    return { title: "Client portal", robots: { index: false, follow: false } };
  }
  return platformMetadata;
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const context = await getPortalHostContext();
  const bodyClass = `${manrope.variable} ${display.variable} font-sans antialiased`;

  // Custom-domain hosts get the org's minimal branded chrome — no MogulForge
  // marketing navigation, footer links, or JSON-LD. Platform hosts unchanged.
  if (context.kind !== "platform") {
    const branding = context.kind === "portal" ? context.branding : null;
    return <html lang="en"><body className={bodyClass}>
      <PortalHeader branding={branding} /><main>{children}</main><PortalFooter branding={branding} /></body></html>;
  }

  return <html lang="en"><body className={bodyClass}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }} />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webSiteJsonLd) }} />
    <Header /><main>{children}</main><Footer /></body></html>;
}
