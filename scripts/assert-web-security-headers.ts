import { buildSecurityHeaders } from "../apps/web/lib/security-headers";

const prodCsp = getCsp(buildSecurityHeaders({
  isProduction: true,
  apiBaseUrl: "https://aionbench.com/api",
}));
const devCsp = getCsp(buildSecurityHeaders({
  isProduction: false,
  apiBaseUrl: undefined,
}));

assert(!prodCsp.includes("'unsafe-eval'"), "Production CSP must not allow unsafe-eval.");
assert(devCsp.includes("'unsafe-eval'"), "Development CSP must allow unsafe-eval for Next dev tooling.");
assert(!prodCsp.includes("localhost:4000"), "Production CSP must not expose local API origins.");
assert(!prodCsp.includes("127.0.0.1:4000"), "Production CSP must not expose local API origins.");
assert(prodCsp.includes("connect-src 'self' https://aionbench.com"), "Production CSP must include configured API origin.");
assert(prodCsp.includes("frame-ancestors 'none'"), "CSP must deny external framing.");
assert(prodCsp.includes("object-src 'none'"), "CSP must deny object/embed execution.");
assert(!hasDuplicateSources(devCsp, "connect-src"), "Development connect-src must not include duplicate origins.");
assert(!hasDuplicateSources(devCsp, "frame-src"), "Development frame-src must not include duplicate origins.");

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
  const value = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `));
  if (!value) throw new Error(`${directive} directive is missing.`);
  const sources = value.split(/\s+/).slice(1);
  return new Set(sources).size !== sources.length;
}
