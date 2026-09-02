import { afterEach, describe, expect, it, vi } from "vitest";

import { gristSsoCallbackUrl, gristSsoUrl, safeGristReturnPath } from "./grist-sso";

describe("Grist SSO return paths", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps local paths and rejects cross-origin targets", () => {
    expect(safeGristReturnPath("/doc/123?view=1")).toBe("/doc/123?view=1");
    expect(safeGristReturnPath("https://evil.example/doc")).toBe("/");
    expect(safeGristReturnPath("//evil.example/doc")).toBe("/");
    expect(safeGristReturnPath("/doc\\evil")).toBe("/");
  });

  it("always redirects through the configured Grist origin", () => {
    const target = gristSsoUrl("/doc/123", "http://localhost:8484");
    expect(target.href).toBe("http://localhost:8484/auth/login?next=%2Fdoc%2F123");
  });

  it("requires HTTPS for production integration", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => gristSsoUrl("/", "http://grist.example.test")).toThrow(/https/u);
  });

  it("creates a short-lived signed callback for the authenticated user", () => {
    const callback = gristSsoCallbackUrl({
      value: "/doc/123",
      gristOrigin: "https://requirements.example.com",
      workbenchOrigin: "https://workbench.example.com",
      secret: "test-secret-that-is-long-enough-for-hmac-signing",
      user: { id: "user-1", email: "owner@example.com" },
      now: 1_000,
      jti: "assertion-1",
    });
    const token = callback.searchParams.get("token");
    const payload = JSON.parse(
      Buffer.from(token!.split(".")[1], "base64url").toString("utf8"),
    );

    expect(callback.origin).toBe("https://requirements.example.com");
    expect(callback.pathname).toBe("/auth/callback");
    expect(payload).toMatchObject({
      iss: "https://workbench.example.com",
      aud: "https://requirements.example.com",
      sub: "user-1",
      email: "owner@example.com",
      next: "/doc/123",
      iat: 1_000,
      exp: 1_060,
      jti: "assertion-1",
    });
  });
});
