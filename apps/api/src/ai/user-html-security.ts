const DEFAULT_WEB_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

export const USER_HTML_CSP = [
  "sandbox",
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  `frame-ancestors 'self' ${readWebFrameAncestors().join(" ")}`,
].join("; ");

export function isUserHtmlPreviewPath(path: string) {
  return /^\/api\/prototype-artifacts\/[^/]+\/preview$/.test(path)
    || /^\/api\/public\/share\/[^/]+\/prototype$/.test(path);
}

function readWebFrameAncestors() {
  const configured = process.env.WEB_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [];
  return [...new Set([...configured, ...DEFAULT_WEB_ORIGINS].map(toOrigin).filter(Boolean))];
}

function toOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
