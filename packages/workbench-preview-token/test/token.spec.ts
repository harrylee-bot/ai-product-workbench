import { describe, expect, it } from "vitest";
import {
  PreviewTokenError,
  createPreviewToken,
  decodePreviewTokenSecret,
  verifyPreviewToken,
} from "../src/index.js";

const secret = Buffer.alloc(32, 7);
const now = new Date("2026-07-13T00:00:00.000Z");

describe("preview capability tokens", () => {
  it("round trips an exact short-lived payload", () => {
    const token = createPreviewToken({
      exportJobId: "export_abc-123",
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    }, secret, { now, maximumTtlSeconds: 600 });
    expect(verifyPreviewToken(token, secret, { now, maximumTtlSeconds: 600 })).toEqual({
      exportJobId: "export_abc-123",
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    });
  });

  it("rejects tampering, expiry, excessive ttl and weak secrets", () => {
    const token = createPreviewToken({
      exportJobId: "export_1",
      expiresAt: new Date(now.getTime() + 60_000),
    }, secret, { now });
    const replacement = token.endsWith("A") ? "B" : "A";
    expect(() => verifyPreviewToken(`${token.slice(0, -1)}${replacement}`, secret, { now })).toThrow(PreviewTokenError);
    expect(() => verifyPreviewToken(token, secret, { now: new Date(now.getTime() + 61_000) })).toThrow("PREVIEW_TOKEN_EXPIRED");
    expect(() => verifyPreviewToken(token, secret, { now: new Date(now.getTime() - 3_600_000), maximumTtlSeconds: 60 })).toThrow("PREVIEW_TOKEN_TTL_EXCEEDED");
    expect(() => createPreviewToken({ exportJobId: "export_1", expiresAt: new Date(now.getTime() + 60_000) }, Buffer.alloc(16), { now })).toThrow("PREVIEW_TOKEN_SECRET_INVALID");
  });

  it("decodes only base64url secrets with at least 256 bits", () => {
    expect(decodePreviewTokenSecret(secret.toString("base64url"))).toEqual(secret);
    expect(() => decodePreviewTokenSecret("not-a-secret")).toThrow("PREVIEW_TOKEN_SECRET_INVALID");
  });
});
