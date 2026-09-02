import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_SECONDS = 60;

export function signSsoToken({
  secret,
  issuer,
  audience,
  userId,
  email,
  next,
  now = Math.floor(Date.now() / 1000),
  jti = randomUUID(),
}) {
  assertSecret(secret);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    v: 1,
    iss: normalizedOrigin(issuer),
    aud: normalizedOrigin(audience),
    sub: userId,
    email,
    next,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    jti,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${signature(unsigned, secret)}`;
}

export function verifySsoToken(token, {
  secret,
  issuer,
  audience,
  now = Math.floor(Date.now() / 1000),
}) {
  assertSecret(secret);
  if (typeof token !== "string" || token.length > 4096) throw new Error("invalid SSO token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid SSO token");
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(signature(unsigned, secret));
  const actual = Buffer.from(parts[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("invalid SSO signature");
  }

  const header = decode(parts[0]);
  const payload = decode(parts[1]);
  if (header?.alg !== "HS256" || header?.typ !== "JWT" || payload?.v !== 1) {
    throw new Error("unsupported SSO token");
  }
  if (payload.iss !== normalizedOrigin(issuer) || payload.aud !== normalizedOrigin(audience)) {
    throw new Error("invalid SSO token audience");
  }
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) {
    throw new Error("invalid SSO token time");
  }
  if (payload.iat > now + 5 || payload.exp < now || payload.exp - payload.iat > TOKEN_TTL_SECONDS) {
    throw new Error("expired SSO token");
  }
  if (!isNonEmptyString(payload.sub) || !isNonEmptyString(payload.jti)) {
    throw new Error("invalid SSO subject");
  }
  if (!isEmail(payload.email) || !isSafePath(payload.next)) {
    throw new Error("invalid SSO profile");
  }
  return payload;
}

export function createReplayGuard() {
  const consumed = new Map();
  return {
    consume(jti, expiresAt, now = Math.floor(Date.now() / 1000)) {
      for (const [key, expiry] of consumed) {
        if (expiry < now) consumed.delete(key);
      }
      if (consumed.has(jti)) return false;
      consumed.set(jti, expiresAt);
      return true;
    },
  };
}

function signature(unsigned, secret) {
  return createHmac("sha256", secret).update(unsigned).digest("base64url");
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid SSO token encoding");
  }
}

function assertSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("WORKBENCH_GRIST_SSO_SECRET must contain at least 32 characters");
  }
}

function normalizedOrigin(value) {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("SSO origin is invalid");
  return url.origin;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function isEmail(value) {
  return typeof value === "string"
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function isSafePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
  if (value.includes("\\") || Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  })) return false;
  try {
    return new URL(value, "http://grist.invalid").origin === "http://grist.invalid";
  } catch {
    return false;
  }
}
