#!/usr/bin/env node

import { readFileSync } from "node:fs";

import YAML from "yaml";

const root = new URL("../", import.meta.url);
const canonicalHeader = "X-Workbench-Client-IP";
const canonicalHeaderEnv = "WORKBENCH_AUTH_CLIENT_IP_HEADER";
const canonicalHeaderName = "x-workbench-client-ip";

const compose = YAML.parse(read("deploy/workbench-compose.yml"));
const webEnvironment = compose.services?.["workbench-web"]?.environment;
assert(
  webEnvironment?.[canonicalHeaderEnv]
    === "${WORKBENCH_AUTH_CLIENT_IP_HEADER:?WORKBENCH_AUTH_CLIENT_IP_HEADER is required and must be x-workbench-client-ip}",
  "workbench-web must require the canonical client IP header contract",
);
assert(
  webEnvironment?.WORKBENCH_ENTERPRISE_SSO_ENABLED
    === "${WORKBENCH_ENTERPRISE_SSO_ENABLED:-false}",
  "workbench-web must default enterprise SSO to disabled",
);
for (const name of [
  "WORKBENCH_OIDC_PROVIDER_ISSUER",
  "WORKBENCH_OIDC_CLIENT_ID",
  "WORKBENCH_OIDC_CLIENT_SECRET",
]) {
  assert(
    webEnvironment?.[name] === `\${${name}:-}`,
    `${name} must not be required unless enterprise SSO is enabled`,
  );
}

const nginx = read("deploy/workbench-nginx.conf");
const previewNginx = read("deploy/workbench-preview-nginx.conf");
const knowledgeRoute = nginx.split("location = /api/v1/runtime/knowledge/retrieve {")[1]
  ?.split("    # Canvas capability calls")[0];
assert(
  knowledgeRoute?.includes("proxy_pass_request_headers off;")
    && knowledgeRoute.includes("proxy_set_header Idempotency-Key $http_idempotency_key;")
    && knowledgeRoute.includes("proxy_set_header Authorization $http_authorization;")
    && knowledgeRoute.includes('proxy_set_header Cookie "";'),
  "the Knowledge capability route must forward its invocation key and grant while stripping cookies",
);
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
    && count(nginx, "proxy_pass_request_headers off;") === 3
    && nginx.includes("proxy_set_header Authorization $http_authorization;")
    && nginx.includes("proxy_set_header Content-Type $http_content_type;")
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
for (const sourceHeader of ["X-Workbench-Edge-Client-IP", "X-Workbench-Edge-Auth"]) {
  assert(
    count(nginx, `proxy_set_header ${sourceHeader} \"\";`) === 7,
    `primary nginx must remove ${sourceHeader} from every upstream request`,
  );
}
const caddy = read("deploy/workbench-server-validation.Caddyfile");
const productionCaddy = read("deploy/workbench-production.Caddyfile");
assert(
  caddy.includes("http://{$WORKBENCH_WEB_HOSTNAME}:{$WORKBENCH_ORIGIN_HTTP_PORT} {")
    && caddy.includes("http://{$WORKBENCH_PREVIEW_HOSTNAME}:{$WORKBENCH_ORIGIN_HTTP_PORT} {")
    && caddy.includes("{$WORKBENCH_S3_HOSTNAME} {")
    && caddy.includes("{$WORKBENCH_IDENTITY_HOSTNAME} {")
    && !caddy.includes("aionbench.com")
    && !caddy.includes("sslip.io"),
  "Caddy must derive every public hostname from validated deployment configuration",
);
assert(
  productionCaddy.includes("http://{$WORKBENCH_WEB_HOSTNAME}:{$WORKBENCH_ORIGIN_HTTP_PORT}")
    && productionCaddy.includes("http://{$WORKBENCH_PREVIEW_HOSTNAME}:{$WORKBENCH_ORIGIN_HTTP_PORT}")
    && !productionCaddy.includes("127.0.0.1:9100")
    && !productionCaddy.includes("127.0.0.1:5556"),
  "production Caddy must contain only Web/Preview routes and no validation-only services",
);
const trustedHandler = caddy.indexOf("handle @trustedEdge");
const canonicalOverwrite = caddy.indexOf(
  `header_up ${canonicalHeader} {http.request.header.X-Workbench-Edge-Client-IP}`,
);
const denyFallback = caddy.lastIndexOf("respond 403");
for (const fragment of [
  "bind {$WORKBENCH_ORIGIN_WIREGUARD_IP}",
  "remote_ip {$WORKBENCH_EDGE_WIREGUARD_IP}",
  "header X-Workbench-Edge-Auth {$WORKBENCH_EDGE_ORIGIN_AUTH_SECRET}",
  "header_up -X-Workbench-Edge-Auth",
]) {
  assert(caddy.includes(fragment), `Caddy auth proxy contract is missing: ${fragment}`);
}
assert(
  trustedHandler !== -1
    && canonicalOverwrite > trustedHandler
    && denyFallback > canonicalOverwrite,
  "Caddy may derive the canonical IP only inside the authenticated Edge handler and must deny fallback traffic",
);
assert(
  count(caddy, `header_up ${canonicalHeader}`) === 1,
  "Caddy must have exactly one canonical client IP writer",
);
for (const source of [caddy, productionCaddy]) {
  assert(
    count(source, "bind {$WORKBENCH_ORIGIN_WIREGUARD_IP}") === 2
      && count(source, "remote_ip {$WORKBENCH_EDGE_WIREGUARD_IP}") === 2
      && count(source, "header X-Workbench-Edge-Auth {$WORKBENCH_EDGE_ORIGIN_AUTH_SECRET}") === 2
      && count(source, "respond 403") === 2,
    "Web and Preview must both fail closed behind the authenticated WireGuard Edge",
  );
  assert(
    source.includes("header_up -Cookie") && source.includes("header_down -Set-Cookie"),
    "Preview must remain cookie-free across the origin proxy",
  );
}

const edgeCaddy = read("deploy/edge/workbench-edge.Caddyfile");
assert(
  edgeCaddy.includes("www.{$WORKBENCH_WEB_HOSTNAME} {")
    && edgeCaddy.includes("@runEvents path_regexp runEvents ^/api/v1/runs/[^/]+/events$")
    && edgeCaddy.includes("flush_interval -1")
    && edgeCaddy.includes("@preview path /preview/*")
    && edgeCaddy.includes("header_up -Cookie")
    && edgeCaddy.includes("header_down -Set-Cookie"),
  "public Edge must own TLS redirect, unbuffered SSE, and the cookie-free Preview boundary",
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
  !authIp.includes("x-forwarded-for") && !authIp.includes("x-workbench-edge-client-ip"),
  "Better Auth IP configuration must not contain a forwarding-header fallback",
);
const oidcStrategy = read("apps/workbench-api/src/modules/identity/oidc-jwt.strategy.ts");
assert(
  oidcStrategy.includes('[WORKBENCH_CANONICAL_CLIENT_IP_HEADER]: INTERNAL_JWKS_CLIENT_IP'),
  "the trusted internal JWKS client must use a separate canonical IP bucket",
);

const preflight = read("deploy/workbench-server-preflight.sh");
const productionPreflight = read("deploy/workbench-production-preflight.sh");
for (const fragment of [
  "require_env WORKBENCH_AUTH_CLIENT_IP_HEADER",
  "require_env WORKBENCH_EDGE_WIREGUARD_IP",
  "require_env WORKBENCH_ORIGIN_WIREGUARD_IP",
  "require_env WORKBENCH_ORIGIN_HTTP_PORT",
  "require_env WORKBENCH_EDGE_ORIGIN_AUTH_SECRET",
  "WORKBENCH_EDGE_WIREGUARD_IP=\"$edge_wireguard_ip\"",
  "WORKBENCH_EDGE_ORIGIN_AUTH_SECRET=\"$edge_origin_auth_secret\"",
]) {
  assert(preflight.includes(fragment), `server preflight is missing: ${fragment}`);
}
assert(
  productionPreflight.includes("require_env WORKBENCH_ENTERPRISE_SSO_ENABLED")
    && !productionPreflight.includes("require_env WORKBENCH_OIDC_PROVIDER_ISSUER")
    && !productionPreflight.includes("require_env WORKBENCH_IDENTITY_HOSTNAME"),
  "production preflight must require the SSO policy without unconditionally requiring OIDC or an identity host",
);
assert(
  preflight.includes("validate_private_ipv4 WORKBENCH_EDGE_WIREGUARD_IP")
    && preflight.includes("Edge and origin WireGuard IPs must differ")
    && preflight.includes('sh "$ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT"')
    && productionPreflight.includes('sh "$ORIGIN_WIREGUARD_PREFLIGHT_SCRIPT"'),
  "origin preflights must require distinct RFC1918 peers and validate the WireGuard route contract",
);
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
for (const variable of [
  "WORKBENCH_EDGE_WIREGUARD_IP",
  "WORKBENCH_ORIGIN_WIREGUARD_IP",
  "WORKBENCH_ORIGIN_HTTP_PORT",
  "WORKBENCH_EDGE_ORIGIN_AUTH_SECRET",
]) {
  assert(caddyReload.includes(variable), `Caddy reload must provide ${variable} during adaptation`);
}
assert(
  [
    "WORKBENCH_WEB_HOSTNAME",
    "WORKBENCH_PREVIEW_HOSTNAME",
    "WORKBENCH_S3_HOSTNAME",
  ].every((name) => caddyReload.includes(name))
    && caddyReload.includes("WORKBENCH_WEB_ORIGIN"),
  "Caddy reload must derive and persist every application public hostname",
);
assert(
  caddyReload.includes('if [ -n "$identity_hostname" ]'),
  "Caddy reload must persist the validation-only identity hostname conditionally",
);
for (const fragment of [
  "workbench-origin-edge.env",
  "install -m 0600",
  "caddy.service.d",
  "systemctl daemon-reload",
  'systemctl reload "$CADDY_SERVICE"',
]) {
  assert(caddyReload.includes(fragment), `Caddy reload persistence contract is missing: ${fragment}`);
}
assert(
  read("deploy/caddy-workbench.service.d/override.conf")
    .includes("EnvironmentFile=/etc/caddy/workbench-origin-edge.env"),
  "Caddy systemd must reload and restart with the dedicated origin Edge environment",
);

const envExample = read("deploy/workbench.env.example");
assert(
  envExample.includes(`${canonicalHeaderEnv}=${canonicalHeaderName}`),
  "deployment env must pin the canonical header name",
);
assert(
  envExample.includes("WORKBENCH_ENTERPRISE_SSO_ENABLED=false")
    && envExample.includes("WORKBENCH_OIDC_PROVIDER_ISSUER=\n")
    && envExample.includes("WORKBENCH_OIDC_CLIENT_ID=\n")
    && envExample.includes("WORKBENCH_OIDC_CLIENT_SECRET=\n"),
  "deployment env must default to product-account login without dormant OIDC configuration",
);
assert(
  envExample.includes("WORKBENCH_EDGE_WIREGUARD_IP=10.88.0.1")
    && envExample.includes("WORKBENCH_ORIGIN_WIREGUARD_IP=10.88.0.2")
    && envExample.includes("WORKBENCH_ORIGIN_HTTP_PORT=8080")
    && /^WORKBENCH_EDGE_ORIGIN_AUTH_SECRET=REPLACE_WITH_/mu.test(envExample),
  "deployment env must pin the WireGuard topology and block on a fresh Edge secret",
);
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
