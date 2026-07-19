import { describe, expect, it } from "vitest";

import { discardStoredOidcIdToken } from "./auth-account-storage";

describe("Better Auth account storage", () => {
  it("drops OIDC ID tokens while preserving encrypted refresh and access tokens", () => {
    expect(discardStoredOidcIdToken({
      accessToken: "$ba$encrypted-access",
      idToken: "plaintext-id-token",
      refreshToken: "$ba$encrypted-refresh",
    })).toEqual({
      accessToken: "$ba$encrypted-access",
      idToken: null,
      refreshToken: "$ba$encrypted-refresh",
    });
  });

  it("also clears a previously stored ID token on unrelated account updates", () => {
    expect(discardStoredOidcIdToken({ scope: "openid profile email" }))
      .toEqual({ idToken: null, scope: "openid profile email" });
  });
});
