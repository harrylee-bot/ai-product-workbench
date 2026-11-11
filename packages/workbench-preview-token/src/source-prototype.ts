import { createHmac, timingSafeEqual } from "node:crypto";
import { PreviewTokenError } from "./index.js";

const prefix = "wbsp1";
const identifier = /^[A-Za-z0-9_-]{1,200}$/u;
export type SourcePrototypePreviewAuthorization =
  | { principalId: string; shareId?: never; shareRevision?: never }
  | { shareId: string; shareRevision: number; principalId?: never };
export type SourcePrototypePreviewIdentity = SourcePrototypePreviewAuthorization & {
  artifactId: string;
  artifactVersionId: string;
  checksum: string;
};
export type SourcePrototypePreviewPayload = SourcePrototypePreviewIdentity & { expiresAt: Date };

export function createSourcePrototypePreviewToken(
  payload: SourcePrototypePreviewPayload,
  secret: Uint8Array,
  options: { now?: Date; maximumTtlSeconds?: number } = {},
) {
  const { expiresAt, ...identity } = payload;
  const value = { v: 1, ...identity, exp: Math.floor(expiresAt.getTime() / 1_000) };
  validate(value, options);
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${prefix}.${encoded}`;
  return `${unsigned}.${sign(unsigned, secret)}`;
}

export function verifySourcePrototypePreviewToken(
  token: string,
  secret: Uint8Array,
  options: { now?: Date; maximumTtlSeconds?: number } = {},
): SourcePrototypePreviewPayload {
  const [kind, encoded, supplied, extra] = token.split(".");
  if (token.length > 2_048 || kind !== prefix || !encoded || !supplied || extra !== undefined
      || !/^[A-Za-z0-9_-]+$/u.test(encoded) || !/^[A-Za-z0-9_-]{43}$/u.test(supplied)) {
    throw new PreviewTokenError("SOURCE_PREVIEW_TOKEN_INVALID");
  }
  const expected = Buffer.from(sign(`${kind}.${encoded}`, secret), "base64url");
  const actual = Buffer.from(supplied, "base64url");
  if (actual.toString("base64url") !== supplied || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PreviewTokenError("SOURCE_PREVIEW_TOKEN_SIGNATURE_INVALID");
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new PreviewTokenError("SOURCE_PREVIEW_TOKEN_INVALID"); }
  validate(value, options);
  const { v: _version, exp, ...identity } = value;
  return { ...identity, expiresAt: new Date(exp * 1_000) } as SourcePrototypePreviewPayload;
}

function sign(value: string, secret: Uint8Array) {
  if (secret.byteLength < 32) throw new PreviewTokenError("PREVIEW_TOKEN_SECRET_INVALID");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

type WirePayload = { v: 1; artifactId: string; artifactVersionId: string; checksum: string; exp: number }
  & SourcePrototypePreviewAuthorization;
function validate(value: unknown, options: { now?: Date; maximumTtlSeconds?: number }): asserts value is WirePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PreviewTokenError("SOURCE_PREVIEW_TOKEN_INVALID");
  const wire = value as Record<string, unknown>;
  const privateAuthorization = typeof wire.principalId === "string" && identifier.test(wire.principalId);
  const sharedAuthorization = typeof wire.shareId === "string" && identifier.test(wire.shareId)
    && Number.isSafeInteger(wire.shareRevision) && (wire.shareRevision as number) >= 0;
  const keys = ["v", "artifactId", "artifactVersionId", "checksum", "exp", ...(privateAuthorization ? ["principalId"] : ["shareId", "shareRevision"])].sort().join(",");
  if (wire.v !== 1 || privateAuthorization === sharedAuthorization || Object.keys(wire).sort().join(",") !== keys
    || typeof wire.artifactId !== "string" || !identifier.test(wire.artifactId)
    || typeof wire.artifactVersionId !== "string" || !identifier.test(wire.artifactVersionId)
    || typeof wire.checksum !== "string" || !/^[a-f0-9]{64}$/u.test(wire.checksum)
    || !Number.isSafeInteger(wire.exp)) throw new PreviewTokenError("SOURCE_PREVIEW_TOKEN_INVALID");
  const now = Math.floor((options.now ?? new Date()).getTime() / 1_000);
  if ((wire.exp as number) <= now) throw new PreviewTokenError("PREVIEW_TOKEN_EXPIRED");
  if ((wire.exp as number) - now > (options.maximumTtlSeconds ?? 3_600)) throw new PreviewTokenError("PREVIEW_TOKEN_TTL_EXCEEDED");
}
