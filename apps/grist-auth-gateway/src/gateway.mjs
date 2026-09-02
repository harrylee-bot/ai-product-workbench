import http from "node:http";

import httpProxy from "http-proxy";

import { createReplayGuard, verifySsoToken } from "./sso-token.mjs";

export const IDENTITY_HEADER = "x-workbench-email";
const SET_DEFAULT_LOCALE = Symbol("set-default-locale");

export function createGatewayServer({
  gristUpstream,
  workbenchOrigin,
  gristPublicOrigin,
  ssoSecret,
  defaultLocale,
  fetchImpl = globalThis.fetch,
  logger = console,
}) {
  const upstream = normalizedOrigin(gristUpstream, "GRIST_UPSTREAM");
  const workbench = normalizedOrigin(workbenchOrigin, "WORKBENCH_ORIGIN");
  const publicGrist = normalizedOrigin(
    gristPublicOrigin ?? "http://localhost:8484",
    "GRIST_PUBLIC_ORIGIN",
  );
  const replayGuard = createReplayGuard();
  const defaultLocaleCookie = buildDefaultLocaleCookie(defaultLocale);
  const proxy = httpProxy.createProxyServer({
    target: upstream,
    ws: true,
    xfwd: true,
  });

  proxy.on("proxyRes", (proxyResponse, request) => {
    if (!defaultLocaleCookie || !request[SET_DEFAULT_LOCALE]) return;
    const existing = proxyResponse.headers["set-cookie"];
    proxyResponse.headers["set-cookie"] = [
      ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
      defaultLocaleCookie,
    ];
  });

  proxy.on("error", (error, _request, response) => {
    logger.error("Grist proxy error", error);
    if (response && "writeHead" in response && !response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("Grist is unavailable");
    }
  });

  const server = http.createServer(async (request, response) => {
    delete request.headers[IDENTITY_HEADER];

    const url = new URL(request.url ?? "/", "http://gateway.invalid");
    if (url.pathname === "/auth/logout") {
      response.writeHead(302, {
        location: new URL("/integrations/grist/logout", workbench).href,
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    if (url.pathname === "/auth/callback" && ssoSecret) {
      try {
        const profile = verifySsoToken(url.searchParams.get("token"), {
          secret: ssoSecret,
          issuer: workbench,
          audience: publicGrist,
        });
        if (!replayGuard.consume(profile.jti, profile.exp)) {
          throw new Error("SSO token was already used");
        }
        request.url = `/auth/login?next=${encodeURIComponent(safeGristPath(profile.next))}`;
        request.headers[IDENTITY_HEADER] = profile.email;
        request[SET_DEFAULT_LOCALE] = !hasCookie(request.headers.cookie, "grist_user_locale");
        proxy.web(request, response);
      } catch (error) {
        logger.error("Workbench SSO callback failed", error);
        response.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end("Workbench SSO assertion is invalid or expired");
      }
      return;
    }

    if (url.pathname === "/auth/login") {
      if (ssoSecret) {
        response.writeHead(302, {
          location: buildWorkbenchBridgeUrl(workbench, url.searchParams.get("next")),
          "cache-control": "no-store",
        });
        response.end();
        return;
      }
      let session;
      try {
        session = await getWorkbenchSession({ request, workbench, fetchImpl });
      } catch (error) {
        logger.error("Workbench session check failed", error);
        response.writeHead(502, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end("Workbench authentication is unavailable");
        return;
      }

      if (!session) {
        response.writeHead(302, {
          location: buildWorkbenchLoginUrl(workbench, url.searchParams.get("next")),
          "cache-control": "no-store",
        });
        response.end();
        return;
      }

      request.headers[IDENTITY_HEADER] = session.email;
      request[SET_DEFAULT_LOCALE] = !hasCookie(request.headers.cookie, "grist_user_locale");
    }

    proxy.web(request, response);
  });

  server.on("upgrade", (request, socket, head) => {
    delete request.headers[IDENTITY_HEADER];
    proxy.ws(request, socket, head);
  });

  return server;
}

function buildDefaultLocaleCookie(locale) {
  if (!locale) return null;
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(locale)) {
    throw new Error("GRIST_DEFAULT_USER_LOCALE must be a valid locale code");
  }
  return `grist_user_locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

function hasCookie(header, name) {
  return typeof header === "string" && header.split(";").some((part) =>
    part.trim().startsWith(`${name}=`));
}

export async function getWorkbenchSession({ request, workbench, fetchImpl }) {
  const headers = new Headers({ accept: "application/json" });
  if (request.headers.cookie) headers.set("cookie", request.headers.cookie);
  if (request.headers["user-agent"]) {
    headers.set("user-agent", request.headers["user-agent"]);
  }

  const response = await fetchImpl(new URL("/api/auth/get-session", workbench), {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Workbench session endpoint returned ${response.status}`);
  }

  const payload = await response.json();
  const email = payload?.user?.email;
  return typeof email === "string" && isEmail(email) ? { email } : null;
}

export function buildWorkbenchLoginUrl(workbenchOrigin, gristNext) {
  const workbench = normalizedOrigin(workbenchOrigin, "WORKBENCH_ORIGIN");
  const bridge = new URL("/integrations/grist/sso", workbench);
  bridge.searchParams.set("next", safeGristPath(gristNext));

  const login = new URL("/login", workbench);
  login.searchParams.set("next", `${bridge.pathname}${bridge.search}`);
  return login.href;
}

export function buildWorkbenchBridgeUrl(workbenchOrigin, gristNext) {
  const workbench = normalizedOrigin(workbenchOrigin, "WORKBENCH_ORIGIN");
  const bridge = new URL("/integrations/grist/sso", workbench);
  bridge.searchParams.set("next", safeGristPath(gristNext));
  return bridge.href;
}

export function safeGristPath(value) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || Array.from(value).some(isControlCharacter)) return "/";
  try {
    const url = new URL(value, "http://grist.invalid");
    return url.origin === "http://grist.invalid"
      ? `${url.pathname}${url.search}${url.hash}`
      : "/";
  } catch {
    return "/";
  }
}

function normalizedOrigin(value, name) {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin`);
  }
  return url.origin;
}

function isControlCharacter(character) {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
}

function isEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}
