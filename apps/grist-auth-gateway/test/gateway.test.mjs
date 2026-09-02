import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";

import {
  buildWorkbenchBridgeUrl,
  buildWorkbenchLoginUrl,
  createGatewayServer,
  safeGristPath,
} from "../src/gateway.mjs";
import { signSsoToken } from "../src/sso-token.mjs";

let upstream;
let gateway;
let upstreamOrigin;
let gatewayOrigin;
let signedGateway;
let signedGatewayOrigin;

const ssoSecret = "test-secret-that-is-long-enough-for-hmac-signing";
const workbenchOrigin = "http://localhost:3000";
const gristPublicOrigin = "https://requirements.example.com";

before(async () => {
  upstream = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ identity: request.headers["x-workbench-email"] ?? null }));
  });
  upstream.on("upgrade", (request, socket) => {
    assert.equal(request.headers["x-workbench-email"], undefined);
    socket.end([
      "HTTP/1.1 101 Switching Protocols",
      "Connection: Upgrade",
      "Upgrade: websocket",
      "",
      "",
    ].join("\r\n"));
  });
  upstreamOrigin = await listen(upstream);
  gateway = createGatewayServer({
    gristUpstream: upstreamOrigin,
    workbenchOrigin: "http://localhost:3000",
    fetchImpl: async (_url, options) => {
      const authenticated = options.headers.get("cookie")?.includes("authenticated=1");
      return Response.json(authenticated ? { user: { email: "owner@example.com" } } : null);
    },
    logger: { error() {} },
  });
  gatewayOrigin = await listen(gateway);
  signedGateway = createGatewayServer({
    gristUpstream: upstreamOrigin,
    workbenchOrigin,
    gristPublicOrigin,
    ssoSecret,
    defaultLocale: "zh-Hans",
    logger: { error() {} },
  });
  signedGatewayOrigin = await listen(signedGateway);
});

after(async () => {
  await close(gateway);
  await close(signedGateway);
  await close(upstream);
});

test("safeGristPath rejects cross-origin and malformed return targets", () => {
  assert.equal(safeGristPath("/doc/123?view=1"), "/doc/123?view=1");
  assert.equal(safeGristPath("https://evil.example/doc"), "/");
  assert.equal(safeGristPath("//evil.example/doc"), "/");
  assert.equal(safeGristPath("/doc\\evil"), "/");
});

test("buildWorkbenchLoginUrl returns through the fixed SSO bridge", () => {
  const login = new URL(buildWorkbenchLoginUrl("http://localhost:3000", "/doc/123"));
  assert.equal(login.pathname, "/login");
  assert.equal(login.searchParams.get("next"), "/integrations/grist/sso?next=%2Fdoc%2F123");
});

test("signed login redirects directly to the Workbench SSO bridge", async () => {
  const response = await fetch(`${signedGatewayOrigin}/auth/login?next=%2Fdoc%2F123`, {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    buildWorkbenchBridgeUrl(workbenchOrigin, "/doc/123"),
  );
});

test("signed callback injects verified identity once and strips spoofed headers", async () => {
  const token = signedToken({ jti: "single-use-token" });
  const callback = `${signedGatewayOrigin}/auth/callback?token=${encodeURIComponent(token)}`;
  const accepted = await fetch(callback, {
    headers: { "x-workbench-email": "attacker@example.com" },
  });
  assert.deepEqual(await accepted.json(), { identity: "owner@example.com" });
  assert.match(
    accepted.headers.getSetCookie().join("\n"),
    /grist_user_locale=zh-Hans; Path=\/; Max-Age=31536000; SameSite=Lax/u,
  );

  const replayed = await fetch(callback);
  assert.equal(replayed.status, 401);

  const normal = await fetch(`${signedGatewayOrigin}/api/docs`, {
    headers: { "x-workbench-email": "attacker@example.com" },
  });
  assert.deepEqual(await normal.json(), { identity: null });
});

test("signed callback preserves an existing locale choice", async () => {
  const token = signedToken({ jti: "existing-locale-token" });
  const response = await fetch(
    `${signedGatewayOrigin}/auth/callback?token=${encodeURIComponent(token)}`,
    { headers: { cookie: "grist_user_locale=en" } },
  );
  assert.deepEqual(await response.json(), { identity: "owner@example.com" });
  assert.doesNotMatch(response.headers.getSetCookie().join("\n"), /grist_user_locale=/u);
});

test("signed callback rejects expired assertions and audience mismatches", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = signedToken({ now: now - 61, jti: "expired-token" });
  const wrongAudience = signedToken({
    audience: "https://other.example.com",
    jti: "wrong-audience-token",
  });

  for (const token of [expired, wrongAudience]) {
    const response = await fetch(
      `${signedGatewayOrigin}/auth/callback?token=${encodeURIComponent(token)}`,
    );
    assert.equal(response.status, 401);
  }
});

test("unauthenticated login redirects to Workbench", async () => {
  const response = await fetch(`${gatewayOrigin}/auth/login?next=%2Fdoc%2F123`, {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location"), /^http:\/\/localhost:3000\/login\?/u);
});

test("authenticated login injects verified identity and ignores spoofed headers", async () => {
  const authenticated = await fetch(`${gatewayOrigin}/auth/login`, {
    headers: {
      cookie: "authenticated=1",
      "x-workbench-email": "attacker@example.com",
    },
  });
  assert.deepEqual(await authenticated.json(), { identity: "owner@example.com" });

  const normal = await fetch(`${gatewayOrigin}/api/docs`, {
    headers: { "x-workbench-email": "attacker@example.com" },
  });
  assert.deepEqual(await normal.json(), { identity: null });
});

test("WebSocket upgrades pass through without caller-supplied identity", async () => {
  const url = new URL(gatewayOrigin);
  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write([
        "GET /ws HTTP/1.1",
        `Host: ${url.host}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "X-Workbench-Email: attacker@example.com",
        "",
        "",
      ].join("\r\n"));
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  assert.match(response, /^HTTP\/1\.1 101 Switching Protocols/u);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function signedToken({
  audience = gristPublicOrigin,
  now,
  jti,
} = {}) {
  return signSsoToken({
    secret: ssoSecret,
    issuer: workbenchOrigin,
    audience,
    userId: "workbench-user-1",
    email: "owner@example.com",
    next: "/doc/123",
    now,
    jti,
  });
}
