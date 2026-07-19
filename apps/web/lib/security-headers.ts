export type SecurityHeader = {
  key: string;
  value: string;
};

export function normalizeBrowserUploadBucketUrl(
  configured: string | undefined,
  isProduction: boolean,
): string | undefined {
  const value = configured?.trim();
  if (!value) {
    if (isProduction) throw new Error("WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL is required");
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL must be a safe HTTP(S) URL");
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (
    !url.hostname
    || !["http:", "https:"].includes(url.protocol)
    || (isProduction && !loopback && url.protocol !== "https:")
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(
      "WORKBENCH_S3_BROWSER_UPLOAD_BUCKET_URL must be HTTPS in production (loopback HTTP is allowed) and must not contain credentials, query, or fragment",
    );
  }
  return value.replace(/\/+$/, "");
}

const localPreviewOrigins = [
  "http://localhost:4300",
  "https://localhost:4300",
  "http://127.0.0.1:4300",
  "https://127.0.0.1:4300",
];

export function buildSecurityHeaders(input: {
  isProduction: boolean;
  previewOrigin?: string;
  uploadBucketUrl?: string;
}): SecurityHeader[] {
  const configuredPreviewOrigins = readOrigin(input.previewOrigin);
  const configuredUploadOrigins = readOrigin(input.uploadBucketUrl);
  const allowedPreviewOrigins = input.isProduction
    ? configuredPreviewOrigins
    : unique([...configuredPreviewOrigins, ...localPreviewOrigins]);
  const scriptSrc = [
    "script-src 'self'",
    "'unsafe-inline'",
    ...(input.isProduction ? [] : ["'unsafe-eval'"]),
  ].join(" ");

  return [
    {
      key: "Content-Security-Policy",
      value: [
        "default-src 'self'",
        scriptSrc,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data: blob:",
        ["connect-src 'self'", ...configuredUploadOrigins].join(" "),
        ["frame-src 'self' blob:", ...allowedPreviewOrigins].join(" "),
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Origin-Agent-Cluster", value: "?1" },
  ];
}

function readOrigin(configured: string | undefined) {
  const trimmed = configured?.trim();
  if (!trimmed) return [];
  try {
    const url = new URL(trimmed);
    if (
      !url.hostname
      || !["http:", "https:"].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return [];
    }
    return [url.origin];
  } catch {
    return [];
  }
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
