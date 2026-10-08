import { createHmac } from "node:crypto";
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
      principalId: "viewer_1",
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    }, secret, { now, maximumTtlSeconds: 600 });
    expect(verifyPreviewToken(token, secret, { now, maximumTtlSeconds: 600 })).toEqual({
      exportJobId: "export_abc-123",
      principalId: "viewer_1",
      expiresAt: new Date(now.getTime() + 5 * 60_000),
    });
  });

  it("rejects tampering, expiry, excessive ttl and weak secrets", () => {
    const token = createPreviewToken({
      exportJobId: "export_1", principalId: "viewer_1",
      expiresAt: new Date(now.getTime() + 60_000),
    }, secret, { now });
    const replacement = token.endsWith("A") ? "B" : "A";
    expect(() => verifyPreviewToken(`${token.slice(0, -1)}${replacement}`, secret, { now })).toThrow(PreviewTokenError);
    expect(() => verifyPreviewToken(token, secret, { now: new Date(now.getTime() + 61_000) })).toThrow("PREVIEW_TOKEN_EXPIRED");
    expect(() => verifyPreviewToken(token, secret, { now: new Date(now.getTime() - 3_600_000), maximumTtlSeconds: 60 })).toThrow("PREVIEW_TOKEN_TTL_EXCEEDED");
    expect(() => createPreviewToken({ exportJobId: "export_1", principalId: "viewer_1", expiresAt: new Date(now.getTime() + 60_000) }, Buffer.alloc(16), { now })).toThrow("PREVIEW_TOKEN_SECRET_INVALID");
  });

  it("decodes only base64url secrets with at least 256 bits", () => {
    expect(decodePreviewTokenSecret(secret.toString("base64url"))).toEqual(secret);
    expect(() => decodePreviewTokenSecret("not-a-secret")).toThrow("PREVIEW_TOKEN_SECRET_INVALID");
  });

  it("only issues requester-bound v2 tokens and retains bounded verification of existing v1 tokens", () => {
    const expiresAt = new Date(now.getTime() + 60_000);
    const current = createPreviewToken({ exportJobId: "export_1", principalId: "viewer_1", expiresAt }, secret, { now });
    expect(current).toMatch(/^wbpv2\./u);
    expect(() => createPreviewToken({ exportJobId: "export_1", expiresAt } as never, secret, { now }))
      .toThrow("PREVIEW_TOKEN_PRINCIPAL_ID_INVALID");
    const unsigned = `wbpv1.${Buffer.from(JSON.stringify({ v: 1, exportJobId: "export_1", exp: expiresAt.getTime() / 1000 })).toString("base64url")}`;
    const legacy = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
    expect(verifyPreviewToken(legacy, secret, { now })).toEqual({ exportJobId: "export_1", expiresAt });
    expect(() => verifyPreviewToken(legacy, secret, { now: expiresAt })).toThrow("PREVIEW_TOKEN_EXPIRED");
    expect(() => verifyPreviewToken(legacy, secret, { now, maximumTtlSeconds: 30 })).toThrow("PREVIEW_TOKEN_TTL_EXCEEDED");
    const parts = current.split(".");
    const changed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    changed.principalId = "other_viewer";
    parts[1] = Buffer.from(JSON.stringify(changed)).toString("base64url");
    expect(() => verifyPreviewToken(parts.join("."), secret, { now })).toThrow("PREVIEW_TOKEN_SIGNATURE_INVALID");
  });
});
