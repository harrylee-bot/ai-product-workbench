import { createHmac, randomUUID } from "node:crypto";

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
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    v: 1,
    iss: new URL(issuer).origin,
    aud: new URL(audience).origin,
    sub: userId,
    email,
    next,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    jti,
  });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
