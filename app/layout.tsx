import type { Metadata } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
const display = Cormorant_Garamond({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });

export const metadata: Metadata = {
  title: { default: "MogulForge GrowthOS | Business Intelligence for Revenue Action", template: "%s | MogulForge" },
  description: "GrowthOS is MogulForge's Business Intelligence Ecosystem for turning leads, pipeline activity, follow-up, and audit evidence into clear next actions.",
  metadataBase: new URL("https://mogulforge.ai"),
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${manrope.variable} ${display.variable} font-sans antialiased`}><Header /><main>{children}</main><Footer /></body></html>;
}

