import type { NextConfig } from "next";
import path from "node:path";
import {
  buildSecurityHeaders,
  normalizeBrowserUploadBucketUrl,
} from "./lib/security-headers";

const isProduction = process.env.NODE_ENV === "production";
const typesPrevalidated = process.env.WORKBENCH_TYPES_PREVALIDATED === "1";
const uploadBucketUrl = normalizeBrowserUploadBucketUrl(
  process.env.WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL,
  isProduction,
);
const securityHeaders = buildSecurityHeaders({
  isProduction,
  previewOrigin: process.env.WORKBENCH_PREVIEW_ORIGIN,
  uploadBucketUrl,
});

const nextConfig: NextConfig = {
  cacheComponents: true,
  devIndicators: false,
  poweredByHeader: false,
  typescript: {
    ignoreBuildErrors: typesPrevalidated,
  },
  env: {
    NEXT_PUBLIC_WORKBENCH_PREVIEW_ORIGIN: process.env.WORKBENCH_PREVIEW_ORIGIN ?? "",
  },
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
    cpus: process.env.WORKBENCH_NEXT_BUILD_CPUS
      ? Number.parseInt(process.env.WORKBENCH_NEXT_BUILD_CPUS, 10)
      : undefined,
    prefetchInlining: true,
    cachedNavigations: true,
    appNewScrollHandler: true,
    inlineCss: true,
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/invitations/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
