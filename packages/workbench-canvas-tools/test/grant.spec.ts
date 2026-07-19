import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CANVAS_TOOL_CAPABILITY_GRANT_PROTOCOL,
  CanvasToolCapabilityGrantError,
  CanvasToolPayloadError,
  canvasToolCapabilityGrantPayloadSha256,
  canvasToolPayloadSha256,
  createCanvasToolCapabilityGrant,
  decodeCanvasToolCapabilitySecret,
  verifyCanvasToolCapabilityGrant,
  type CanvasToolCapabilityGrantPayload,
} from "../src/index.js";

const secret = Buffer.alloc(32, 23);
const now = new Date("2026-07-17T08:00:00.000Z");
const payload: CanvasToolCapabilityGrantPayload = {
  grantId: "grant_123",
  principalId: "principal_123",
  projectId: "project_123",
  threadId: "thread_123",
  runId: "run_123",
  runtimeAttemptId: "attempt_123",
  agentSessionId: "session_123",
  boardId: "board_123",
  declarationSha256: "a".repeat(64),
  issuedAt: now,
  notBefore: now,
  expiresAt: new Date(now.getTime() + 5 * 60_000),
};

describe("canvas tool capability grants", () => {
  it("round trips every bound context field under its independent protocol", () => {
    const token = createCanvasToolCapabilityGrant(payload, secret, { now });

    expect(token.startsWith(`${CANVAS_TOOL_CAPABILITY_GRANT_PROTOCOL}.`)).toBe(true);
    expect(verifyCanvasToolCapabilityGrant(token, secret, { now })).toEqual(payload);
  });

  it("uses explicit null Run context without an omission ambiguity", () => {
    const liveSessionPayload = { ...payload, runId: null, runtimeAttemptId: null };
    const token = createCanvasToolCapabilityGrant(liveSessionPayload, secret, { now });

    expect(verifyCanvasToolCapabilityGrant(token, secret, { now })).toMatchObject({
      runId: null,
      runtimeAttemptId: null,
    });
    expect(() => createCanvasToolCapabilityGrant({
      ...liveSessionPayload,
      runtimeAttemptId: "attempt_orphaned",
    }, secret, { now })).toThrow("CANVAS_TOOL_CAPABILITY_GRANT_CONTEXT_INVALID");
    const omitted = { ...liveSessionPayload } as Record<string, unknown>;
    delete omitted.runId;
    expect(() => createCanvasToolCapabilityGrant(omitted as never, secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  });

  it("rejects tampering, a different secret, and a different protocol", () => {
    const token = createCanvasToolCapabilityGrant(payload, secret, { now });
    const replacement = token.endsWith("A") ? "B" : "A";

    expect(() => verifyCanvasToolCapabilityGrant(`${token.slice(0, -1)}${replacement}`, secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_SIGNATURE_INVALID");
    expect(() => verifyCanvasToolCapabilityGrant(token, Buffer.alloc(32, 24), { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_SIGNATURE_INVALID");
    expect(() => verifyCanvasToolCapabilityGrant(token.replace(/^wbct1/u, "wbkg1"), secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  });

  it("requires strict identifiers, lowercase declaration hashes, and exact fields", () => {
    expect(() => createCanvasToolCapabilityGrant({ ...payload, boardId: "not/an/id" }, secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_ID_INVALID");
    expect(() => createCanvasToolCapabilityGrant({ ...payload, declarationSha256: "A".repeat(64) }, secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_DECLARATION_HASH_INVALID");
    expect(() => createCanvasToolCapabilityGrant({ ...payload, unexpected: true } as never, secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  });

  it("enforces iat <= nbf < exp, a short TTL, future issuance, nbf, and hard expiry", () => {
    expect(() => createCanvasToolCapabilityGrant({
      ...payload,
      notBefore: new Date(now.getTime() - 1_000),
    }, secret, { now })).toThrow("CANVAS_TOOL_CAPABILITY_GRANT_TIME_INVALID");
    expect(() => createCanvasToolCapabilityGrant({
      ...payload,
      expiresAt: payload.notBefore,
    }, secret, { now })).toThrow("CANVAS_TOOL_CAPABILITY_GRANT_TIME_INVALID");
    expect(() => createCanvasToolCapabilityGrant({
      ...payload,
      expiresAt: new Date(now.getTime() + 301_000),
    }, secret, { now })).toThrow("CANVAS_TOOL_CAPABILITY_GRANT_TTL_EXCEEDED");
    expect(() => createCanvasToolCapabilityGrant({
      ...payload,
      issuedAt: new Date(now.getTime() + 31_000),
      notBefore: new Date(now.getTime() + 31_000),
      expiresAt: new Date(now.getTime() + 60_000),
    }, secret, { now })).toThrow("CANVAS_TOOL_CAPABILITY_GRANT_ISSUED_IN_FUTURE");
    expect(() => createCanvasToolCapabilityGrant({
      ...payload,
      notBefore: new Date(now.getTime() + 31_000),
    }, secret, { now })).toThrow("CANVAS_TOOL_CAPABILITY_GRANT_NOT_YET_VALID");

    const token = createCanvasToolCapabilityGrant(payload, secret, { now });
    expect(() => verifyCanvasToolCapabilityGrant(token, secret, { now: payload.expiresAt }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_EXPIRED");
    expect(() => verifyCanvasToolCapabilityGrant(token, secret, {
      now,
      maximumTtlSeconds: 299,
    })).toThrow("CANVAS_TOOL_CAPABILITY_GRANT_TTL_EXCEEDED");

    const delayedPayload = {
      ...payload,
      issuedAt: new Date(now.getTime() - 60_000),
      notBefore: new Date(now.getTime() + 20_000),
      expiresAt: new Date(now.getTime() + 120_000),
    };
    const delayedToken = createCanvasToolCapabilityGrant(delayedPayload, secret, {
      now,
      clockSkewSeconds: 30,
    });
    expect(() => verifyCanvasToolCapabilityGrant(delayedToken, secret, {
      now,
      clockSkewSeconds: 0,
    })).toThrow("CANVAS_TOOL_CAPABILITY_GRANT_NOT_YET_VALID");
    expect(verifyCanvasToolCapabilityGrant(delayedToken, secret, {
      now: new Date(now.getTime() + 20_000),
      clockSkewSeconds: 0,
    })).toEqual(delayedPayload);

    expect(() => verifyCanvasToolCapabilityGrant(token, secret, {
      now: new Date(now.getTime() - 31_000),
    })).toThrow("CANVAS_TOOL_CAPABILITY_GRANT_ISSUED_IN_FUTURE");
  });

  it("bounds explicit TTL and clock-skew policy overrides", () => {
    expect(() => createCanvasToolCapabilityGrant(payload, secret, { now, maximumTtlSeconds: 3_601 }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_TTL_INVALID");
    expect(() => createCanvasToolCapabilityGrant(payload, secret, { now, clockSkewSeconds: 61 }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_CLOCK_SKEW_INVALID");
    expect(() => createCanvasToolCapabilityGrant(payload, secret, { now, unsafe: true } as never))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_OPTIONS_INVALID");
  });

  it("rejects validly signed but non-canonical or structurally extended payloads", () => {
    const wire = {
      v: 1,
      grantId: payload.grantId,
      principalId: payload.principalId,
      projectId: payload.projectId,
      threadId: payload.threadId,
      runId: payload.runId,
      runtimeAttemptId: payload.runtimeAttemptId,
      agentSessionId: payload.agentSessionId,
      boardId: payload.boardId,
      declarationSha256: payload.declarationSha256,
      iat: Math.floor(payload.issuedAt.getTime() / 1_000),
      nbf: Math.floor(payload.notBefore.getTime() / 1_000),
      exp: Math.floor(payload.expiresAt.getTime() / 1_000),
    };
    const nonCanonical = JSON.stringify(wire, null, 1);
    const extended = JSON.stringify({ ...wire, authority: "admin" });

    expect(() => verifyCanvasToolCapabilityGrant(signRaw(nonCanonical), secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
    expect(() => verifyCanvasToolCapabilityGrant(signRaw(extended), secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  });

  it("rejects malformed token encodings before interpreting authority", () => {
    const invalidUtf8 = Buffer.from([0xff]).toString("base64url");
    const unsigned = `${CANVAS_TOOL_CAPABILITY_GRANT_PROTOCOL}.${invalidUtf8}`;
    const signature = createHmac("sha256", secret).update(unsigned, "utf8").digest("base64url");

    expect(() => verifyCanvasToolCapabilityGrant(`${unsigned}.${signature}`, secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
    expect(() => verifyCanvasToolCapabilityGrant("", secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
    expect(() => verifyCanvasToolCapabilityGrant("x".repeat(4_097), secret, { now }))
      .toThrow("CANVAS_TOOL_CAPABILITY_GRANT_INVALID");
  });

  it("decodes only canonical base64url secrets between 256 and 512 bits", () => {
    expect(decodeCanvasToolCapabilitySecret(secret.toString("base64url"))).toEqual(secret);
    expect(decodeCanvasToolCapabilitySecret(Buffer.alloc(64, 11).toString("base64url"))).toHaveLength(64);
    expect(() => decodeCanvasToolCapabilitySecret(Buffer.alloc(31).toString("base64url")))
      .toThrow("CANVAS_TOOL_CAPABILITY_SECRET_INVALID");
    expect(() => decodeCanvasToolCapabilitySecret(`${secret.toString("base64url")}=`))
      .toThrow("CANVAS_TOOL_CAPABILITY_SECRET_INVALID");
    expect(() => decodeCanvasToolCapabilitySecret(Buffer.alloc(65).toString("base64url")))
      .toThrow("CANVAS_TOOL_CAPABILITY_SECRET_INVALID");
    expect(() => decodeCanvasToolCapabilitySecret(undefined as never))
      .toThrow("CANVAS_TOOL_CAPABILITY_SECRET_INVALID");
  });
});

describe("canonical canvas tool payload hashes", () => {
  it("is stable across object key order and fixes the grant's second-level wire representation", () => {
    expect(canvasToolPayloadSha256({ z: [true, null, "产品工作台"], a: 1 }))
      .toBe(canvasToolPayloadSha256({ a: 1, z: [true, null, "产品工作台"] }));
    expect(canvasToolPayloadSha256({ a: 1, z: [true, null, "产品工作台"] }))
      .toBe("1d16e854e248acc4b6a80f9e5776e878f1677c6d239d4dd36f1abf6bdcb8bcd6");
    expect(canvasToolCapabilityGrantPayloadSha256(payload))
      .toBe("5a9c73eb322b4ffa559a6bef6e3b160ea88204f65b365d1240ad2aa6fdc09ced");
  });

  it("rejects values that are not unambiguous JSON data", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = Array(1);

    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      new Date(),
      { missing: undefined },
      sparse,
      cyclic,
      "\ud800",
    ]) {
      expect(() => canvasToolPayloadSha256(value)).toThrow(CanvasToolPayloadError);
    }

    const withSymbol = { allowed: true, [Symbol("hidden")]: true };
    const withAccessor = Object.defineProperty({}, "authority", {
      enumerable: true,
      get: () => "admin",
    });
    const withNonEnumerable = Object.defineProperty({}, "authority", {
      enumerable: false,
      value: "admin",
    });
    for (const value of [withSymbol, withAccessor, withNonEnumerable]) {
      expect(() => canvasToolPayloadSha256(value)).toThrow(CanvasToolPayloadError);
    }
  });
});

function signRaw(json: string): string {
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  const unsigned = `${CANVAS_TOOL_CAPABILITY_GRANT_PROTOCOL}.${encoded}`;
  const signature = createHmac("sha256", secret).update(unsigned, "utf8").digest("base64url");
  return `${unsigned}.${signature}`;
}

expect(CanvasToolCapabilityGrantError).toBeDefined();
