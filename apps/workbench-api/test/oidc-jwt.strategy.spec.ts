import { describe, expect, it, vi } from "vitest";

const passportJwtSecretMock = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock("jwks-rsa", () => ({ passportJwtSecret: passportJwtSecretMock }));

import { OidcJwtStrategy } from "../src/modules/identity/oidc-jwt.strategy.js";

describe("OidcJwtStrategy verified email boundary", () => {
  it("gives the trusted internal JWKS fetch its own canonical IP bucket", () => {
    new OidcJwtStrategy(
      {
        get: vi.fn((name: string) => ({
          OIDC_ISSUER: "https://workbench.example.test",
          OIDC_AUDIENCE: "workbench",
          OIDC_JWKS_URL: "http://workbench-web:3000/api/auth/jwks",
        })[name]),
      } as never,
      { resolvePrincipal: vi.fn() } as never,
    );

    expect(passportJwtSecretMock).toHaveBeenCalledWith(expect.objectContaining({
      requestHeaders: { "x-workbench-client-ip": "127.0.0.1" },
    }));
  });

  it("only trusts an OIDC email when email_verified is true", async () => {
    const resolvePrincipal = vi.fn(async (claims) => claims);
    const strategy = new OidcJwtStrategy(
      {
        get: vi.fn((name: string) => ({
          OIDC_ISSUER: "https://identity.example.test",
          OIDC_AUDIENCE: "workbench",
          OIDC_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
        })[name]),
      } as never,
      { resolvePrincipal } as never,
    );

    await strategy.validate({
      sub: "subject-1",
      iss: "https://identity.example.test",
      email: "verified@example.test",
      email_verified: true,
    });
    await strategy.validate({
      sub: "subject-2",
      iss: "https://identity.example.test",
      email: "internal@example.test",
      emailVerified: true,
    });
    await strategy.validate({
      sub: "subject-3",
      iss: "https://identity.example.test",
      email: "unverified@example.test",
      email_verified: false,
    });
    await strategy.validate({
      sub: "subject-4",
      iss: "https://identity.example.test",
      email: "unknown@example.test",
    });

    expect(resolvePrincipal).toHaveBeenNthCalledWith(1, expect.objectContaining({
      email: "verified@example.test",
    }));
    expect(resolvePrincipal).toHaveBeenNthCalledWith(2, expect.objectContaining({
      email: "internal@example.test",
    }));
    expect(resolvePrincipal).toHaveBeenNthCalledWith(3, expect.objectContaining({ email: null }));
    expect(resolvePrincipal).toHaveBeenNthCalledWith(4, expect.objectContaining({ email: null }));
  });
});
