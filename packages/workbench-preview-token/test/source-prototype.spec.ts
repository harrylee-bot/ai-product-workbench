import { describe, expect, it } from "vitest";
import { createSourcePrototypePreviewToken, verifySourcePrototypePreviewToken } from "../src/index.js";

const secret = Buffer.alloc(32, 13);
const now = new Date("2026-11-03T00:00:00Z");
const identity = { artifactId: "artifact-source", artifactVersionId: "version-source", checksum: "a".repeat(64) };
const expiresAt = new Date(now.getTime() + 60_000);

describe("SourcePrototype preview capabilities", () => {
  it.each([{ principalId: "viewer-1" }, { shareId: "share-1", shareRevision: 3 }])("round-trips a bounded identity and authorization", (authorization) => {
    const payload = { ...identity, ...authorization, expiresAt };
    const token = createSourcePrototypePreviewToken(payload, secret, { now });
    expect(token).toMatch(/^wbsp1\./u);
    expect(verifySourcePrototypePreviewToken(token, secret, { now })).toEqual(payload);
  });
  it("rejects tampering, a different key, expiry and excessive TTL", () => {
    const token = createSourcePrototypePreviewToken({ ...identity, principalId: "viewer-1", expiresAt }, secret, { now });
    expect(() => verifySourcePrototypePreviewToken(token.slice(0, -2) + "aa", secret, { now })).toThrow();
    expect(() => verifySourcePrototypePreviewToken(token, Buffer.alloc(32, 14), { now })).toThrow();
    expect(() => verifySourcePrototypePreviewToken(token, secret, { now: expiresAt })).toThrow("EXPIRED");
    expect(() => createSourcePrototypePreviewToken({ ...identity, principalId: "viewer-1", expiresAt }, secret, { now, maximumTtlSeconds: 30 })).toThrow("TTL_EXCEEDED");
  });
  it("requires exactly one authorization channel and a valid immutable checksum", () => {
    for (const authorization of [{}, { principalId: "viewer", shareId: "share", shareRevision: 1 }, { shareId: "share", shareRevision: -1 }]) {
      expect(() => createSourcePrototypePreviewToken({ ...identity, ...authorization, expiresAt } as never, secret, { now })).toThrow();
    }
    expect(() => createSourcePrototypePreviewToken({ ...identity, principalId: "viewer", checksum: "broken", expiresAt }, secret, { now })).toThrow();
  });
});
