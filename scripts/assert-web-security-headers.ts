import { buildSecurityHeaders } from "../apps/web/lib/security-headers";

const prodCsp = getCsp(buildSecurityHeaders({
  isProduction: true,
  previewOrigin: "https://preview.aionbench.com",
  uploadBucketUrl: "https://uploads.aionbench.com/workbench",
}));
const devCsp = getCsp(buildSecurityHeaders({
  isProduction: false,
  previewOrigin: "http://localhost:4300",
}));

assert(!prodCsp.includes("'unsafe-eval'"), "Production CSP must not allow unsafe-eval.");
assert(devCsp.includes("'unsafe-eval'"), "Development CSP must allow unsafe-eval for Next dev tooling.");
assert(!prodCsp.includes("localhost:4000"), "Production CSP must not expose local API origins.");
assert(!prodCsp.includes("127.0.0.1:4000"), "Production CSP must not expose local API origins.");
assert(!devCsp.includes("localhost:4000"), "Development CSP must not expose the legacy API origin.");
assert(!devCsp.includes("127.0.0.1:4000"), "Development CSP must not expose the legacy API origin.");
assert(
  readDirective(prodCsp, "connect-src") === "connect-src 'self' https://uploads.aionbench.com",
  "Production traffic must use the same-origin BFF plus the exact browser upload origin.",
);
assert(readDirective(devCsp, "connect-src") === "connect-src 'self'", "Development API traffic must use the same-origin BFF.");
assert(prodCsp.includes("frame-src 'self' blob: https://preview.aionbench.com"), "Production CSP must allow only the configured Preview frame origin.");
assert(prodCsp.includes("frame-ancestors 'none'"), "CSP must deny external framing.");
assert(prodCsp.includes("object-src 'none'"), "CSP must deny object/embed execution.");
assert(!hasDuplicateSources(devCsp, "connect-src"), "Development connect-src must not include duplicate origins.");
assert(!hasDuplicateSources(devCsp, "frame-src"), "Development frame-src must not include duplicate origins.");
assert(!prodCsp.includes("/workbench"), "CSP must contain an origin, not the bucket path.");

console.log("Web security headers are production-tight and development-compatible.");

function getCsp(headers: { key: string; value: string }[]) {
  const csp = headers.find((header) => header.key === "Content-Security-Policy")?.value;
  if (!csp) throw new Error("Content-Security-Policy header is missing.");
  return csp;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hasDuplicateSources(csp: string, directive: string) {
  const value = readDirective(csp, directive);
  const sources = value.split(/\s+/).slice(1);
  return new Set(sources).size !== sources.length;
}

function readDirective(csp: string, directive: string) {
  const value = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `));
  if (!value) throw new Error(`${directive} directive is missing.`);
  return value;
}
