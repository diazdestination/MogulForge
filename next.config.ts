import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: [
    ...(process.env.REPLIT_DEV_DOMAIN ? [process.env.REPLIT_DEV_DOMAIN] : []),
    ...(process.env.REPLIT_DOMAINS ? process.env.REPLIT_DOMAINS.split(",") : []),
    "*.replit.dev",
    "*.replit.app",
    "127.0.0.1",
    "localhost",
  ],
};

export default nextConfig;

