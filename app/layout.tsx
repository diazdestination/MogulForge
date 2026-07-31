import type { Metadata } from "next";
import { Cormorant_Garamond, Manrope } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });
const display = Cormorant_Garamond({ subsets: ["latin"], variable: "--font-display", weight: ["500", "600", "700"] });

export const metadata: Metadata = {
  title: { default: "MogulForge | Recover the Revenue You're Already Losing", template: "%s | MogulForge" },
  description: "AI Revenue Rescue™ finds the hidden leaks costing your business leads and sales—then installs the systems that recover them.",
  metadataBase: new URL("https://mogulforge.com"),
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${manrope.variable} ${display.variable} font-sans antialiased`}><Header /><main>{children}</main><Footer /></body></html>;
}

