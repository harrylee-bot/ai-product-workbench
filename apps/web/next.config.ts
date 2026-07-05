import type { NextConfig } from "next";
import path from "node:path";
import { buildSecurityHeaders } from "./lib/security-headers";

const isProduction = process.env.NODE_ENV === "production";
const securityHeaders = buildSecurityHeaders({
  isProduction,
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
});

const nextConfig: NextConfig = {
  cacheComponents: true,
  devIndicators: false,
  poweredByHeader: false,
  reactCompiler: true,
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
  logging: {
    fetches: {
      fullUrl: false,
    },
    incomingRequests: false,
  },
  experimental: {
    prefetchInlining: true,
    cachedNavigations: true,
    appNewScrollHandler: true,
    inlineCss: true,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
