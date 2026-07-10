const DEV_WEB_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

export const USER_HTML_CSP = buildUserHtmlCsp();

export function buildUserHtmlCsp() {
  const frameAncestors = ["'self'", ...readWebFrameAncestors()].join(" ");
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

export function isUserHtmlPreviewPath(path: string) {
  return /^\/api\/prototype-artifacts\/[^/]+\/preview$/.test(path)
    || /^\/api\/authenticated-share\/[^/]+\/prototype$/.test(path);
}

function readWebFrameAncestors() {
  const configured = process.env.WEB_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];
  const origins = process.env.NODE_ENV === "production"
    ? configured
    : [...configured, ...DEV_WEB_ORIGINS];
  return [...new Set(origins.map(toOrigin).filter(Boolean))];
}

function toOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
