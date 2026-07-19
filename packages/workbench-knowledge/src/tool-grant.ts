import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const protocol = "wbkg1";
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;

export type KnowledgeToolGrantPayload = {
  readonly grantId: string;
  readonly runId: string;
  readonly runtimeAttemptId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly releaseId: string;
  readonly mode: "hybrid";
  readonly routeScope: "production";
  readonly issuedAt: Date;
  readonly expiresAt: Date;
};

export class KnowledgeToolGrantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "KnowledgeToolGrantError";
  }
}

export function createKnowledgeToolGrant(
  payload: KnowledgeToolGrantPayload,
  secret: Uint8Array,
  options: { readonly now?: Date; readonly maximumTtlSeconds?: number } = {},
): string {
  assertSecret(secret);
  assertPayloadIdentifiers(payload);
  const maximumTtlSeconds = maximumTtl(options.maximumTtlSeconds);
  const nowSeconds = dateSeconds(options.now ?? new Date());
  const issuedAt = dateSeconds(payload.issuedAt);
  const expiresAt = dateSeconds(payload.expiresAt);
  if (
    issuedAt > nowSeconds + 30
    || expiresAt <= nowSeconds
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > maximumTtlSeconds
  ) {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_EXPIRY_INVALID");
  }
  const encodedPayload = encodePayload(payload);
  const unsigned = `${protocol}.${encodedPayload}`;
  return `${unsigned}.${signature(unsigned, secret)}`;
}

export function knowledgeToolGrantPayloadSha256(payload: KnowledgeToolGrantPayload): string {
  assertPayloadIdentifiers(payload);
  return createHash("sha256").update(Buffer.from(encodePayload(payload), "base64url")).digest("hex");
}

export function verifyKnowledgeToolGrant(
  token: string,
  secret: Uint8Array,
  options: { readonly now?: Date; readonly maximumTtlSeconds?: number } = {},
): KnowledgeToolGrantPayload {
  assertSecret(secret);
  if (typeof token !== "string" || token.length > 4_096) {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_INVALID");
  }
  const [prefix, encodedPayload, suppliedSignature, extra] = token.split(".");
  if (
    prefix !== protocol
    || !encodedPayload
    || !suppliedSignature
    || extra !== undefined
    || !/^[A-Za-z0-9_-]+$/u.test(encodedPayload)
    || !/^[A-Za-z0-9_-]{43}$/u.test(suppliedSignature)
  ) {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_INVALID");
  }
  const unsigned = `${prefix}.${encodedPayload}`;
  const expected = Buffer.from(signature(unsigned, secret), "base64url");
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (
    supplied.toString("base64url") !== suppliedSignature
    || expected.byteLength !== supplied.byteLength
    || !timingSafeEqual(expected, supplied)
  ) {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_SIGNATURE_INVALID");
  }

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_INVALID");
  }
  if (!isExactPayload(value)) throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_INVALID");
  const maximumTtlSeconds = maximumTtl(options.maximumTtlSeconds);
  const nowSeconds = dateSeconds(options.now ?? new Date());
  if (value.exp <= nowSeconds) throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_EXPIRED");
  if (value.iat > nowSeconds + 30 || value.exp <= value.iat || value.exp - value.iat > maximumTtlSeconds) {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_TTL_EXCEEDED");
  }
  return {
    grantId: value.grantId,
    runId: value.runId,
    runtimeAttemptId: value.runtimeAttemptId,
    principalId: value.principalId,
    projectId: value.projectId,
    releaseId: value.releaseId,
    mode: value.mode,
    routeScope: value.routeScope,
    issuedAt: new Date(value.iat * 1_000),
    expiresAt: new Date(value.exp * 1_000),
  };
}

export function decodeKnowledgeToolSecret(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43,86}$/u.test(value)) {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_SECRET_INVALID");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_SECRET_INVALID");
  }
  assertSecret(bytes);
  return bytes;
}

function signature(unsigned: string, secret: Uint8Array): string {
  return createHmac("sha256", secret).update(unsigned).digest("base64url");
}

function assertSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_SECRET_INVALID");
  }
}

function assertPayloadIdentifiers(payload: KnowledgeToolGrantPayload): void {
  for (const value of [
    payload.grantId,
    payload.runId,
    payload.runtimeAttemptId,
    payload.principalId,
    payload.projectId,
    payload.releaseId,
  ]) {
    if (!identifierPattern.test(value)) throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_ID_INVALID");
  }
  if (payload.mode !== "hybrid" || payload.routeScope !== "production") {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_SCOPE_INVALID");
  }
}

function isExactPayload(value: unknown): value is {
  v: 1;
  grantId: string;
  runId: string;
  runtimeAttemptId: string;
  principalId: string;
  projectId: string;
  releaseId: string;
  mode: "hybrid";
  routeScope: "production";
  iat: number;
  exp: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "exp,grantId,iat,mode,principalId,projectId,releaseId,routeScope,runId,runtimeAttemptId,v") {
    return false;
  }
  return candidate.v === 1
    && typeof candidate.grantId === "string" && identifierPattern.test(candidate.grantId)
    && typeof candidate.runId === "string" && identifierPattern.test(candidate.runId)
    && typeof candidate.runtimeAttemptId === "string" && identifierPattern.test(candidate.runtimeAttemptId)
    && typeof candidate.principalId === "string" && identifierPattern.test(candidate.principalId)
    && typeof candidate.projectId === "string" && identifierPattern.test(candidate.projectId)
    && typeof candidate.releaseId === "string" && identifierPattern.test(candidate.releaseId)
    && candidate.mode === "hybrid"
    && candidate.routeScope === "production"
    && typeof candidate.iat === "number"
    && Number.isSafeInteger(candidate.iat)
    && typeof candidate.exp === "number"
    && Number.isSafeInteger(candidate.exp);
}

function encodePayload(payload: KnowledgeToolGrantPayload): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    grantId: payload.grantId,
    runId: payload.runId,
    runtimeAttemptId: payload.runtimeAttemptId,
    principalId: payload.principalId,
    projectId: payload.projectId,
    releaseId: payload.releaseId,
    mode: payload.mode,
    routeScope: payload.routeScope,
    iat: dateSeconds(payload.issuedAt),
    exp: dateSeconds(payload.expiresAt),
  }), "utf8").toString("base64url");
}

function maximumTtl(value: number | undefined): number {
  const result = value ?? 900;
  if (!Number.isSafeInteger(result) || result < 1 || result > 86_400) {
    throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_TTL_INVALID");
  }
  return result;
}

function dateSeconds(value: Date): number {
  const result = Math.floor(value.getTime() / 1_000);
  if (!Number.isSafeInteger(result)) throw new KnowledgeToolGrantError("KNOWLEDGE_TOOL_GRANT_TIME_INVALID");
  return result;
}
