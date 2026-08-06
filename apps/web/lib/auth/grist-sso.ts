import { createHmac, randomUUID } from "node:crypto";

const DEFAULT_GRIST_ORIGIN = "http://localhost:8484";
const TOKEN_TTL_SECONDS = 60;

export function gristSsoUrl(value: string | null, configuredOrigin?: string) {
  const origin = normalizedGristOrigin(
    configuredOrigin ?? process.env.WORKBENCH_GRIST_ORIGIN ?? DEFAULT_GRIST_ORIGIN,
  );
  const target = new URL("/auth/login", origin);
  target.searchParams.set("next", safeGristReturnPath(value));
  return target;
}

export function gristSsoCallbackUrl({
  value,
  gristOrigin,
  workbenchOrigin,
  secret,
  user,
  now = Math.floor(Date.now() / 1000),
  jti = randomUUID(),
}: {
  value: string | null;
  gristOrigin: string;
  workbenchOrigin: string;
  secret: string;
  user: { id: string; email: string };
  now?: number;
  jti?: string;
}) {
  assertSecret(secret);
  const audience = normalizedGristOrigin(gristOrigin);
  const issuer = normalizedOrigin(workbenchOrigin, "BETTER_AUTH_URL");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    v: 1,
    iss: issuer,
    aud: audience,
    sub: user.id,
    email: user.email,
    next: safeGristReturnPath(value),
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    jti,
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  const callback = new URL("/auth/callback", audience);
  callback.searchParams.set("token", `${unsigned}.${signature}`);
  return callback;
}

export function safeGristReturnPath(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || Array.from(value).some(hasControlCharacter)) return "/";
  try {
    const url = new URL(value, "http://grist.invalid");
    return url.origin === "http://grist.invalid"
      ? `${url.pathname}${url.search}${url.hash}`
      : "/";
  } catch {
    return "/";
  }
}

function normalizedGristOrigin(value: string): string {
  return normalizedOrigin(value, "WORKBENCH_GRIST_ORIGIN", true);
}

function normalizedOrigin(value: string, name: string, requireProductionHttps = false): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an origin`);
  }
  if (requireProductionHttps && process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error(`${name} must use https in production`);
  }
  return url.origin;
}

function assertSecret(secret: string) {
  if (secret.length < 32) {
    throw new Error("WORKBENCH_GRIST_SSO_SECRET must contain at least 32 characters");
  }
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function hasControlCharacter(character: string) {
  const code = character.charCodeAt(0);
  return code < 32 || code === 127;
}
