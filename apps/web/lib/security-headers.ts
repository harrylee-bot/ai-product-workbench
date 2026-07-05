export type SecurityHeader = {
  key: string;
  value: string;
};

const localApiOrigins = [
  "http://localhost:4000",
  "https://localhost:4000",
  "http://127.0.0.1:4000",
  "https://127.0.0.1:4000",
];

export function buildSecurityHeaders(input: {
  isProduction: boolean;
  apiBaseUrl?: string;
}): SecurityHeader[] {
  const apiOrigin = readApiOrigin(input.apiBaseUrl, input.isProduction);
  const allowedApiOrigins = input.isProduction
    ? apiOrigin
    : unique([...apiOrigin, ...localApiOrigins]);
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
        "font-src 'self' data:",
        ["connect-src 'self'", ...allowedApiOrigins].join(" "),
        ["frame-src 'self' blob:", ...allowedApiOrigins].join(" "),
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

function readApiOrigin(configured: string | undefined, isProduction: boolean) {
  const trimmed = configured?.trim();
  if (!trimmed) return [];
  try {
    return [new URL(trimmed).origin];
  } catch {
    return isProduction ? [] : ["http://localhost:4000"];
  }
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
