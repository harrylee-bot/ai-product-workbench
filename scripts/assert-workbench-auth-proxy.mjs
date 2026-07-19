#!/usr/bin/env node

import { readFileSync } from "node:fs";

import YAML from "yaml";

const root = new URL("../", import.meta.url);
const canonicalHeader = "X-Workbench-Client-IP";
const canonicalHeaderEnv = "WORKBENCH_AUTH_CLIENT_IP_HEADER";
const canonicalHeaderName = "x-workbench-client-ip";

const compose = YAML.parse(read("deploy/workbench-compose.yml"));
assert(
  compose.services?.["workbench-web"]?.environment?.[canonicalHeaderEnv]
    === "${WORKBENCH_AUTH_CLIENT_IP_HEADER:?WORKBENCH_AUTH_CLIENT_IP_HEADER is required and must be x-workbench-client-ip}",
  "workbench-web must require the canonical client IP header contract",
);

const nginx = read("deploy/workbench-nginx.conf");
const previewNginx = read("deploy/workbench-preview-nginx.conf");
for (const [source, label] of [
  [nginx, "primary nginx"],
  [previewNginx, "Preview nginx"],
]) {
  assert(!source.includes("$proxy_add_x_forwarded_for"), `${label} must never append forwarded IP hops`);
}
assert(
  count(nginx, "proxy_set_header X-Forwarded-For $http_x_workbench_client_ip;") === 7,
  "primary nginx must overwrite every upstream X-Forwarded-For value with the canonical client IP",
);
assert(
  count(nginx, `proxy_set_header ${canonicalHeader} $http_x_workbench_client_ip;`) === 2,
  "primary nginx must explicitly overwrite the canonical header for both Web routes",
);
assert(
  count(nginx, `proxy_set_header ${canonicalHeader} \"\";`) === 5,
  "primary nginx must remove the auth-only canonical header from non-Web upstreams",
);
assert(
  nginx.includes("location = /api/v1/runtime/canvas/tools/execute")
    && nginx.includes("proxy_pass http://workbench_api/api/v1/runtime/canvas/tools/execute;")
    && nginx.includes("proxy_set_header Authorization $http_authorization;")
    && nginx.includes("proxy_set_header Idempotency-Key $http_idempotency_key;")
    && nginx.includes("limit_req zone=workbench_canvas_tool"),
  "primary nginx must expose the exact server-side Canvas capability route",
);
assert(
  nginx.includes('location ~ "^/api/v1/runtime/canvas/visuals/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"')
    && nginx.includes("limit_req zone=workbench_canvas_visual")
    && nginx.includes("proxy_set_header If-None-Match $http_if_none_match;")
    && nginx.includes("proxy_pass_request_headers off;"),
  "primary nginx must expose only a constrained Canvas visual capability object route",
);
for (const sourceHeader of ["Ali-Cdn-Real-Ip", "X-Workbench-Origin-Auth"]) {
  assert(
    count(nginx, `proxy_set_header ${sourceHeader} \"\";`) === 7,
    `primary nginx must remove ${sourceHeader} from every upstream request`,
  );
}
assert(
  !nginx.includes(`proxy_set_header ${canonicalHeader} $http_ali_cdn_real_ip`),
  "nginx must not trust Ali-Cdn-Real-Ip directly",
);

const caddy = read("deploy/workbench-server-validation.Caddyfile");
const productionCaddy = read("deploy/workbench-production.Caddyfile");
assert(
  caddy.includes("www.{$WORKBENCH_WEB_HOSTNAME} {")
    && caddy.includes("{$WORKBENCH_WEB_HOSTNAME} {")
    && caddy.includes("{$WORKBENCH_PREVIEW_HOSTNAME} {")
    && caddy.includes("{$WORKBENCH_S3_HOSTNAME} {")
    && caddy.includes("{$WORKBENCH_IDENTITY_HOSTNAME} {")
    && !caddy.includes("aionbench.com")
    && !caddy.includes("sslip.io"),
  "Caddy must derive every public hostname from validated deployment configuration",
);
assert(
  productionCaddy.includes("{$WORKBENCH_WEB_HOSTNAME}")
    && productionCaddy.includes("{$WORKBENCH_PREVIEW_HOSTNAME}")
    && !productionCaddy.includes("127.0.0.1:9100")
    && !productionCaddy.includes("127.0.0.1:5556"),
  "production Caddy must contain only Web/Preview routes and no validation-only services",
);
const trustedHandler = caddy.indexOf("handle @trustedCdn");
const canonicalOverwrite = caddy.indexOf(
  `header_up ${canonicalHeader} {http.request.header.Ali-Cdn-Real-Ip}`,
);
const denyFallback = caddy.lastIndexOf("respond 403");
for (const fragment of [
  "remote_ip {$WORKBENCH_CDN_EDGE_CIDRS}",
  "header X-Workbench-Origin-Auth {$WORKBENCH_CDN_ORIGIN_AUTH_SECRET}",
  "header_up -X-Workbench-Origin-Auth",
]) {
  assert(caddy.includes(fragment), `Caddy auth proxy contract is missing: ${fragment}`);
}
assert(
  trustedHandler !== -1
    && canonicalOverwrite > trustedHandler
    && denyFallback > canonicalOverwrite,
  "Caddy may derive the canonical IP only inside the authenticated CDN handler and must deny fallback traffic",
);
assert(
  count(caddy, `header_up ${canonicalHeader}`) === 1,
  "Caddy must have exactly one canonical client IP writer",
);

const legacyCaddy = read("deploy/Caddyfile");
assert(
  legacyCaddy.includes("import workbench-production.Caddyfile")
    && !legacyCaddy.includes("127.0.0.1:3000")
    && !legacyCaddy.includes("127.0.0.1:4000"),
  "the default Caddy entrypoint must select the production greenfield configuration",
);

const authIp = read("apps/web/lib/auth/workbench-auth-ip.ts");
assert(
  authIp.includes(`WORKBENCH_CANONICAL_CLIENT_IP_HEADER = \"${canonicalHeaderName}\"`),
  "Better Auth canonical header constant is missing",
);
assert(
  !authIp.includes("x-forwarded-for") && !authIp.includes("ali-cdn-real-ip"),
  "Better Auth IP configuration must not contain a forwarding-header fallback",
);
const oidcStrategy = read("apps/workbench-api/src/modules/identity/oidc-jwt.strategy.ts");
assert(
  oidcStrategy.includes('[WORKBENCH_CANONICAL_CLIENT_IP_HEADER]: INTERNAL_JWKS_CLIENT_IP'),
  "the trusted internal JWKS client must use a separate canonical IP bucket",
);

const preflight = read("deploy/workbench-server-preflight.sh");
for (const fragment of [
  "require_env WORKBENCH_AUTH_CLIENT_IP_HEADER",
  "require_env WORKBENCH_CDN_EDGE_CIDRS",
  "require_env WORKBENCH_CDN_EDGE_CIDRS_SOURCE",
  "require_env WORKBENCH_CDN_ORIGIN_AUTH_SECRET",
  "WORKBENCH_CDN_EDGE_CIDRS=\"$cdn_edge_cidrs\"",
  "WORKBENCH_CDN_ORIGIN_AUTH_SECRET=\"$cdn_origin_auth_secret\"",
]) {
  assert(preflight.includes(fragment), `server preflight is missing: ${fragment}`);
}
for (const unsafeRange of ["0.0.0.0/0", "::/0"]) {
  assert(preflight.includes(unsafeRange), `server preflight must reject ${unsafeRange}`);
}
const deployScript = read("deploy/server-deploy.sh");
assert(
  deployScript.includes('PREFLIGHT_SCRIPT="$WORKBENCH_PREFLIGHT_SCRIPT"')
    && deployScript.includes('PREFLIGHT_SCRIPT="$APP_DIR/deploy/workbench-server-preflight.sh"')
    && deployScript.includes('PREFLIGHT_SCRIPT="$APP_DIR/deploy/workbench-production-preflight.sh"'),
  "the deploy entrypoint must select a fail-closed preflight for validation and production",
);

const caddyReload = read("deploy/workbench-caddy-reload.sh");
assert(
  caddyReload.includes('sh "$PREFLIGHT_SCRIPT"'),
  "Caddy reload must pass the complete production preflight before adapting config",
);
for (const variable of ["WORKBENCH_CDN_EDGE_CIDRS", "WORKBENCH_CDN_ORIGIN_AUTH_SECRET"]) {
  assert(caddyReload.includes(variable), `Caddy reload must provide ${variable} during adaptation`);
}
assert(
  [
    "WORKBENCH_WEB_HOSTNAME",
    "WORKBENCH_PREVIEW_HOSTNAME",
    "WORKBENCH_S3_HOSTNAME",
    "WORKBENCH_IDENTITY_HOSTNAME",
  ].every((name) => caddyReload.includes(name))
    && caddyReload.includes("WORKBENCH_WEB_ORIGIN"),
  "Caddy reload must derive and persist every public hostname",
);
for (const fragment of [
  "workbench-auth-proxy.env",
  "install -m 0600",
  "caddy.service.d",
  "systemctl daemon-reload",
  'systemctl reload "$CADDY_SERVICE"',
]) {
  assert(caddyReload.includes(fragment), `Caddy reload persistence contract is missing: ${fragment}`);
}
assert(
  read("deploy/caddy-workbench.service.d/override.conf")
    .includes("EnvironmentFile=/etc/caddy/workbench-auth-proxy.env"),
  "Caddy systemd must reload and restart with the dedicated auth proxy environment",
);

const envExample = read("deploy/workbench.env.example");
assert(
  envExample.includes(`${canonicalHeaderEnv}=${canonicalHeaderName}`),
  "deployment env must pin the canonical header name",
);
for (const variable of [
  "WORKBENCH_CDN_EDGE_CIDRS",
  "WORKBENCH_CDN_EDGE_CIDRS_SOURCE",
  "WORKBENCH_CDN_ORIGIN_AUTH_SECRET",
]) {
  assert(
    new RegExp(`^${variable}=REPLACE_WITH_`, "m").test(envExample),
    `${variable} must remain an explicit blocking placeholder until verified deployment data exists`,
  );
}

console.log("Workbench auth proxy contract passed.");

function count(source, fragment) {
  return source.split(fragment).length - 1;
}

function read(path) {
  return readFileSync(new URL(path, root), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
