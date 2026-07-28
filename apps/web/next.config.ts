import type { NextConfig } from "next";
import path from "node:path";
import {
  buildSecurityHeaders,
  normalizeBrowserUploadBucketUrl,
} from "./lib/security-headers";

const isProduction = process.env.NODE_ENV === "production";
const typesPrevalidated = process.env.WORKBENCH_TYPES_PREVALIDATED === "1";
const configuredDistDir = process.env.WORKBENCH_NEXT_DIST_DIR?.trim();
const configuredTsconfigPath = process.env.WORKBENCH_NEXT_TSCONFIG_PATH?.trim();
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
  ...(configuredDistDir ? { distDir: configuredDistDir } : {}),
  cacheComponents: true,
  devIndicators: false,
  poweredByHeader: false,
  typescript: {
    ...(configuredTsconfigPath ? { tsconfigPath: configuredTsconfigPath } : {}),
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
