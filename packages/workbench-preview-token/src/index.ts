import { createHmac, timingSafeEqual } from "node:crypto";

const protocol = "wbpv2";
const exportJobIdPattern = /^[A-Za-z0-9_-]{1,200}$/;

export type PreviewTokenPayload = {
  exportJobId: string;
  expiresAt: Date;
  principalId?: string;
};

export class PreviewTokenError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PreviewTokenError";
  }
}

export function createPreviewToken(
  payload: PreviewTokenPayload & { principalId: string },
  secret: Uint8Array,
  options: { now?: Date; maximumTtlSeconds?: number } = {},
) {
  assertSecret(secret);
  if (!exportJobIdPattern.test(payload.exportJobId)) throw new PreviewTokenError("PREVIEW_TOKEN_EXPORT_JOB_ID_INVALID");
  if (typeof payload.principalId !== "string" || !exportJobIdPattern.test(payload.principalId)) {
    throw new PreviewTokenError("PREVIEW_TOKEN_PRINCIPAL_ID_INVALID");
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const expiresAt = Math.floor(payload.expiresAt.getTime() / 1_000);
  const maximumTtlSeconds = options.maximumTtlSeconds ?? 3_600;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || expiresAt - nowSeconds > maximumTtlSeconds) {
    throw new PreviewTokenError("PREVIEW_TOKEN_EXPIRY_INVALID");
  }
  const encodedPayload = Buffer.from(JSON.stringify({ v: 2, exportJobId: payload.exportJobId, principalId: payload.principalId, exp: expiresAt }), "utf8").toString("base64url");
  const unsigned = `${protocol}.${encodedPayload}`;
  return `${unsigned}.${signature(unsigned, secret)}`;
}

export function verifyPreviewToken(
  token: string,
  secret: Uint8Array,
  options: { now?: Date; maximumTtlSeconds?: number } = {},
): PreviewTokenPayload {
  assertSecret(secret);
  if (token.length > 1_024) throw new PreviewTokenError("PREVIEW_TOKEN_INVALID");
  const [prefix, encodedPayload, suppliedSignature, extra] = token.split(".");
  if ((prefix !== protocol && prefix !== "wbpv1") || !encodedPayload || !suppliedSignature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)) {
    throw new PreviewTokenError("PREVIEW_TOKEN_INVALID");
  }
  const unsigned = `${prefix}.${encodedPayload}`;
  const expected = Buffer.from(signature(unsigned, secret), "base64url");
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (supplied.toString("base64url") !== suppliedSignature
    || expected.byteLength !== supplied.byteLength
    || !timingSafeEqual(expected, supplied)) {
    throw new PreviewTokenError("PREVIEW_TOKEN_SIGNATURE_INVALID");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new PreviewTokenError("PREVIEW_TOKEN_INVALID");
  }
  if (!isExactPayload(payload) || prefix !== `wbpv${payload.v}`) throw new PreviewTokenError("PREVIEW_TOKEN_INVALID");
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  const maximumTtlSeconds = options.maximumTtlSeconds ?? 3_600;
  if (payload.exp <= nowSeconds) throw new PreviewTokenError("PREVIEW_TOKEN_EXPIRED");
  if (payload.exp - nowSeconds > maximumTtlSeconds) throw new PreviewTokenError("PREVIEW_TOKEN_TTL_EXCEEDED");
  return {
    exportJobId: payload.exportJobId,
    expiresAt: new Date(payload.exp * 1_000),
    ...(payload.v === 2 ? { principalId: payload.principalId } : {}),
  };
}

export function decodePreviewTokenSecret(value: string) {
  if (!/^[A-Za-z0-9_-]{43,86}$/.test(value)) throw new PreviewTokenError("PREVIEW_TOKEN_SECRET_INVALID");
  const bytes = Buffer.from(value, "base64url");
  assertSecret(bytes);
  return bytes;
}

function signature(unsigned: string, secret: Uint8Array) {
  return createHmac("sha256", secret).update(unsigned).digest("base64url");
}

function assertSecret(secret: Uint8Array) {
  if (secret.byteLength < 32) throw new PreviewTokenError("PREVIEW_TOKEN_SECRET_INVALID");
}

function isExactPayload(value: unknown): value is
  | { v: 1; exportJobId: string; exp: number }
  | { v: 2; exportJobId: string; exp: number; principalId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const validVersion = candidate.v === 1
    ? Object.keys(candidate).sort().join(",") === "exp,exportJobId,v"
    : candidate.v === 2
      && Object.keys(candidate).sort().join(",") === "exp,exportJobId,principalId,v"
      && typeof candidate.principalId === "string"
      && exportJobIdPattern.test(candidate.principalId);
  return validVersion
    && typeof candidate.exportJobId === "string"
    && exportJobIdPattern.test(candidate.exportJobId)
    && typeof candidate.exp === "number"
    && Number.isSafeInteger(candidate.exp);
}

export * from "./source-prototype.js";
