import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  connection: vi.fn(),
  enterpriseSsoEnabled: vi.fn(),
  publicRegistrationEnabled: vi.fn(),
}));

vi.mock("next/server", () => ({
  connection: server.connection,
}));

vi.mock("@/lib/auth/workbench-enterprise-sso-policy", () => ({
  isWorkbenchEnterpriseSsoEnabled: server.enterpriseSsoEnabled,
}));

vi.mock("@/lib/auth/workbench-registration-policy", () => ({
  isWorkbenchPublicRegistrationEnabled: server.publicRegistrationEnabled,
}));

import { LoginPage } from "./login-page";
import Page from "./page";

beforeEach(() => {
  server.connection.mockReset().mockResolvedValue(undefined);
  server.enterpriseSsoEnabled.mockReset();
  server.publicRegistrationEnabled.mockReset();
});

describe("login route policy", () => {
  it.each([
    { enterpriseSsoEnabled: true, publicRegistrationEnabled: true },
    { enterpriseSsoEnabled: false, publicRegistrationEnabled: false },
  ])(
    "passes runtime server policy to the login client",
    async ({ enterpriseSsoEnabled, publicRegistrationEnabled }) => {
      server.enterpriseSsoEnabled.mockReturnValue(enterpriseSsoEnabled);
      server.publicRegistrationEnabled.mockReturnValue(publicRegistrationEnabled);

      const result = await Page();

      expect(server.connection).toHaveBeenCalledOnce();
      expect(server.enterpriseSsoEnabled).toHaveBeenCalledOnce();
      expect(server.publicRegistrationEnabled).toHaveBeenCalledOnce();
      expect(result.type).toBe(LoginPage);
      expect(result.props).toEqual({
        enterpriseSsoEnabled,
        publicRegistrationEnabled,
      });
    },
  );
});
