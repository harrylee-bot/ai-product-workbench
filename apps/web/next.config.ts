import type { NextConfig } from "next";
import path from "node:path";

const apiConnectOrigin = readApiConnectOrigin();

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      [
        "connect-src 'self'",
        apiConnectOrigin,
        "http://localhost:4000",
        "https://localhost:4000",
        "http://127.0.0.1:4000",
        "https://127.0.0.1:4000",
      ].join(" "),
      "frame-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  turbopack: {
    root: path.resolve(process.cwd(), "../.."),
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

function readApiConnectOrigin() {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (!configured) return "http://localhost:4000";
  try {
    return new URL(configured).origin;
  } catch {
    return "http://localhost:4000";
  }
}

export default nextConfig;
