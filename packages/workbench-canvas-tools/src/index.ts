import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

import canonicalizeModule from "canonicalize";

export const CANVAS_TOOL_CAPABILITY_GRANT_PROTOCOL = "wbct1" as const;
export const CANVAS_TOOL_PAYLOAD_HASH_ALGORITHM = "jcs-sha256-v1" as const;

const DEFAULT_MAXIMUM_TTL_SECONDS = 300;
const MAXIMUM_CONFIGURABLE_TTL_SECONDS = 3_600;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const MAXIMUM_CLOCK_SKEW_SECONDS = 60;
const MAXIMUM_TOKEN_LENGTH = 4_096;
const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_SECRET_BYTES = 64;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const signaturePattern = /^[A-Za-z0-9_-]{43}$/u;
const canonicalize = canonicalizeModule as unknown as (input: unknown) => string | undefined;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type CanvasToolCapabilityGrantPayload = {
  readonly grantId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly runtimeAttemptId: string | null;
  readonly agentSessionId: string;
  readonly boardId: string;
  readonly declarationSha256: string;
  readonly issuedAt: Date;
  readonly notBefore: Date;
  readonly expiresAt: Date;
};

export type CanvasToolCapabilityGrantOptions = {
  readonly now?: Date;
  readonly maximumTtlSeconds?: number;
  readonly clockSkewSeconds?: number;
};

export class CanvasToolCapabilityGrantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CanvasToolCapabilityGrantError";
  }
}

export class CanvasToolPayloadError extends TypeError {
  constructor(readonly code: string = "CANVAS_TOOL_PAYLOAD_NOT_JSON") {
    super(code);
    this.name = "CanvasToolPayloadError";
  }
}

export function createCanvasToolCapabilityGrant(
  payload: CanvasToolCapabilityGrantPayload,
  secret: Uint8Array,
  options: CanvasToolCapabilityGrantOptions = {},
): string {
  const signingSecret = validatedSecret(secret);
  const policy = grantPolicy(options);
  const wirePayload = wirePayloadFromExternal(payload);
  assertGrantTimePolicy(wirePayload, policy, "create");

  const encodedPayload = Buffer.from(canonicalJson(wirePayload), "utf8").toString("base64url");
  const unsigned = `${CANVAS_TOOL_CAPABILITY_GRANT_PROTOCOL}.${encodedPayload}`;
  return `${unsigned}.${signature(unsigned, signingSecret)}`;
}

export function verifyCanvasToolCapabilityGrant(
  token: string,
  secret: Uint8Array,
  options: CanvasToolCapabilityGrantOptions = {},
): CanvasToolCapabilityGrantPayload {
  const verificationSecret = validatedSecret(secret);
  const policy = grantPolicy(options);
  if (typeof token !== "string" || token.length === 0 || token.length > MAXIMUM_TOKEN_LENGTH) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  }

  const [prefix, encodedPayload, suppliedSignature, extra] = token.split(".");
  if (
    prefix !== CANVAS_TOOL_CAPABILITY_GRANT_PROTOCOL
    || !encodedPayload
    || !suppliedSignature
    || extra !== undefined
    || !base64UrlPattern.test(encodedPayload)
    || !signaturePattern.test(suppliedSignature)
  ) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  }

  const unsigned = `${prefix}.${encodedPayload}`;
  const expected = Buffer.from(signature(unsigned, verificationSecret), "base64url");
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (
    supplied.toString("base64url") !== suppliedSignature
    || expected.byteLength !== supplied.byteLength
    || !timingSafeEqual(expected, supplied)
  ) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_SIGNATURE_INVALID");
  }

  let decodedPayload: string;
  let parsedPayload: unknown;
  try {
    const payloadBytes = Buffer.from(encodedPayload, "base64url");
    if (payloadBytes.toString("base64url") !== encodedPayload) {
      throw new Error("non-canonical base64url");
    }
    decodedPayload = utf8Decoder.decode(payloadBytes);
    parsedPayload = JSON.parse(decodedPayload) as unknown;
  } catch {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  }

  const wirePayload = validatedWirePayload(parsedPayload);
  if (canonicalJson(wirePayload) !== decodedPayload) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  }
  assertGrantTimePolicy(wirePayload, policy, "verify");
  return externalPayloadFromWire(wirePayload);
}

export function canvasToolCapabilityGrantPayloadSha256(
  payload: CanvasToolCapabilityGrantPayload,
): string {
  return canvasToolPayloadSha256(wirePayloadFromExternal(payload));
}

export function canvasToolPayloadSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function decodeCanvasToolCapabilitySecret(value: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,86}$/u.test(value)) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_SECRET_INVALID");
  }
  const secret = Buffer.from(value, "base64url");
  if (secret.toString("base64url") !== value) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_SECRET_INVALID");
  }
  return validatedSecret(secret);
}

type WirePayload = {
  readonly v: 1;
  readonly grantId: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly runtimeAttemptId: string | null;
  readonly agentSessionId: string;
  readonly boardId: string;
  readonly declarationSha256: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
};

type GrantPolicy = {
  readonly nowSeconds: number;
  readonly maximumTtlSeconds: number;
  readonly clockSkewSeconds: number;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

function canonicalJson(value: unknown): string {
  const normalized = normalizeJson(value, new Set<object>());
  let result: string | undefined;
  try {
    result = canonicalize(normalized);
  } catch {
    throw new CanvasToolPayloadError();
  }
  if (result === undefined) throw new CanvasToolPayloadError();
  return result;
}

function normalizeJson(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertValidUnicode(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanvasToolPayloadError();
    return value;
  }
  if (typeof value !== "object") throw new CanvasToolPayloadError();
  if (ancestors.has(value)) throw new CanvasToolPayloadError();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return normalizeJsonArray(value, ancestors);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CanvasToolPayloadError();

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const normalized = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys) {
      if (typeof key !== "string") throw new CanvasToolPayloadError();
      assertValidUnicode(key);
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new CanvasToolPayloadError();
      }
      normalized[key] = normalizeJson(descriptor.value, ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeJsonArray(value: unknown[], ancestors: Set<object>): JsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new CanvasToolPayloadError();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) throw new CanvasToolPayloadError();
  const expectedKeys = new Set<string>(["length"]);
  const normalized: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    expectedKeys.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new CanvasToolPayloadError();
    }
    normalized.push(normalizeJson(descriptor.value, ancestors));
  }
  if (ownKeys.length !== expectedKeys.size || ownKeys.some((key) => !expectedKeys.has(key as string))) {
    throw new CanvasToolPayloadError();
  }
  return normalized;
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) throw new CanvasToolPayloadError();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanvasToolPayloadError();
    }
  }
}

function wirePayloadFromExternal(payload: CanvasToolCapabilityGrantPayload): WirePayload {
  assertExactDataObject(payload, [
    "agentSessionId",
    "boardId",
    "declarationSha256",
    "expiresAt",
    "grantId",
    "issuedAt",
    "notBefore",
    "principalId",
    "projectId",
    "runId",
    "runtimeAttemptId",
    "threadId",
  ], "CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  const wirePayload = {
    v: 1 as const,
    grantId: payload.grantId,
    principalId: payload.principalId,
    projectId: payload.projectId,
    threadId: payload.threadId,
    runId: payload.runId,
    runtimeAttemptId: payload.runtimeAttemptId,
    agentSessionId: payload.agentSessionId,
    boardId: payload.boardId,
    declarationSha256: payload.declarationSha256,
    iat: dateSeconds(payload.issuedAt),
    nbf: dateSeconds(payload.notBefore),
    exp: dateSeconds(payload.expiresAt),
  };
  return validatedWirePayload(wirePayload);
}

function validatedWirePayload(value: unknown): WirePayload {
  assertExactDataObject(value, [
    "agentSessionId",
    "boardId",
    "declarationSha256",
    "exp",
    "grantId",
    "iat",
    "nbf",
    "principalId",
    "projectId",
    "runId",
    "runtimeAttemptId",
    "threadId",
    "v",
  ], "CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== 1) throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");

  for (const field of [
    "grantId",
    "principalId",
    "projectId",
    "threadId",
    "agentSessionId",
    "boardId",
  ] as const) {
    if (typeof candidate[field] !== "string" || !identifierPattern.test(candidate[field])) {
      throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_ID_INVALID");
    }
  }
  for (const field of ["runId", "runtimeAttemptId"] as const) {
    const identifier = candidate[field];
    if (identifier !== null && (typeof identifier !== "string" || !identifierPattern.test(identifier))) {
      throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_ID_INVALID");
    }
  }
  if (candidate.runtimeAttemptId !== null && candidate.runId === null) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_CONTEXT_INVALID");
  }
  if (typeof candidate.declarationSha256 !== "string" || !sha256Pattern.test(candidate.declarationSha256)) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_DECLARATION_HASH_INVALID");
  }
  const iat = candidate.iat;
  const nbf = candidate.nbf;
  const exp = candidate.exp;
  if (
    typeof iat !== "number"
    || !Number.isSafeInteger(iat)
    || iat < 0
    || typeof nbf !== "number"
    || !Number.isSafeInteger(nbf)
    || nbf < 0
    || typeof exp !== "number"
    || !Number.isSafeInteger(exp)
    || exp < 0
    || !(iat <= nbf && nbf < exp)
  ) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_TIME_INVALID");
  }
  return candidate as WirePayload;
}

function externalPayloadFromWire(payload: WirePayload): CanvasToolCapabilityGrantPayload {
  return {
    grantId: payload.grantId,
    principalId: payload.principalId,
    projectId: payload.projectId,
    threadId: payload.threadId,
    runId: payload.runId,
    runtimeAttemptId: payload.runtimeAttemptId,
    agentSessionId: payload.agentSessionId,
    boardId: payload.boardId,
    declarationSha256: payload.declarationSha256,
    issuedAt: new Date(payload.iat * 1_000),
    notBefore: new Date(payload.nbf * 1_000),
    expiresAt: new Date(payload.exp * 1_000),
  };
}

function assertGrantTimePolicy(payload: WirePayload, policy: GrantPolicy, operation: "create" | "verify"): void {
  if (payload.exp - payload.iat > policy.maximumTtlSeconds) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_TTL_EXCEEDED");
  }
  if (payload.iat > policy.nowSeconds + policy.clockSkewSeconds) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_ISSUED_IN_FUTURE");
  }
  if (payload.nbf > policy.nowSeconds + policy.clockSkewSeconds) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_NOT_YET_VALID");
  }
  if (payload.exp <= policy.nowSeconds) {
    throw new CanvasToolCapabilityGrantError(
      operation === "verify" ? "CANVAS_TOOL_CAPABILITY_GRANT_EXPIRED" : "CANVAS_TOOL_CAPABILITY_GRANT_EXPIRY_INVALID",
    );
  }
}

function grantPolicy(options: CanvasToolCapabilityGrantOptions): GrantPolicy {
  assertExactDataObject(options, ["clockSkewSeconds", "maximumTtlSeconds", "now"], "CANVAS_TOOL_CAPABILITY_GRANT_OPTIONS_INVALID", true);
  const maximumTtlSeconds = options.maximumTtlSeconds ?? DEFAULT_MAXIMUM_TTL_SECONDS;
  if (
    !Number.isSafeInteger(maximumTtlSeconds)
    || maximumTtlSeconds < 1
    || maximumTtlSeconds > MAXIMUM_CONFIGURABLE_TTL_SECONDS
  ) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_TTL_INVALID");
  }
  const clockSkewSeconds = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (
    !Number.isSafeInteger(clockSkewSeconds)
    || clockSkewSeconds < 0
    || clockSkewSeconds > MAXIMUM_CLOCK_SKEW_SECONDS
  ) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_CLOCK_SKEW_INVALID");
  }
  return {
    nowSeconds: dateSeconds(options.now ?? new Date()),
    maximumTtlSeconds,
    clockSkewSeconds,
  };
}

function dateSeconds(value: unknown): number {
  if (!(value instanceof Date) || Object.getPrototypeOf(value) !== Date.prototype) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_TIME_INVALID");
  }
  const milliseconds = Date.prototype.getTime.call(value);
  const seconds = Math.floor(milliseconds / 1_000);
  if (!Number.isFinite(milliseconds) || !Number.isSafeInteger(seconds) || seconds < 0) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_GRANT_TIME_INVALID");
  }
  return seconds;
}

function validatedSecret(secret: Uint8Array): Buffer {
  if (
    !(secret instanceof Uint8Array)
    || secret.byteLength < MINIMUM_SECRET_BYTES
    || secret.byteLength > MAXIMUM_SECRET_BYTES
  ) {
    throw new CanvasToolCapabilityGrantError("CANVAS_TOOL_CAPABILITY_SECRET_INVALID");
  }
  return Buffer.from(secret);
}

function signature(unsigned: string, secret: Uint8Array): string {
  return createHmac("sha256", secret).update(unsigned, "utf8").digest("base64url");
}

function assertExactDataObject(
  value: unknown,
  allowedKeys: readonly string[],
  errorCode: string,
  allowMissingKeys = false,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CanvasToolCapabilityGrantError(errorCode);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanvasToolCapabilityGrantError(errorCode);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== "string")
    || (!allowMissingKeys && keys.length !== allowedKeys.length)
    || keys.some((key) => !allowedKeys.includes(key as string))
  ) {
    throw new CanvasToolCapabilityGrantError(errorCode);
  }
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new CanvasToolCapabilityGrantError(errorCode);
    }
  }
}
