import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ["*.replit.dev", "*.replit.app", "127.0.0.1", "localhost"],
};

export default nextConfig;

