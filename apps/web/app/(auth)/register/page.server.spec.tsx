import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  connection: vi.fn(),
  redirect: vi.fn(),
  redirectError: new Error("expected redirect"),
  registrationEnabled: vi.fn(),
}));

vi.mock("next/server", () => ({
  connection: server.connection,
}));

vi.mock("next/navigation", () => ({
  redirect: server.redirect,
}));

vi.mock("@/lib/auth/workbench-registration-policy", () => ({
  isWorkbenchPublicRegistrationEnabled: server.registrationEnabled,
}));

import { RegisterPage } from "./register-page";
import Page from "./page";

beforeEach(() => {
  server.connection.mockReset().mockResolvedValue(undefined);
  server.redirect.mockReset().mockImplementation(() => {
    throw server.redirectError;
  });
  server.registrationEnabled.mockReset();
});

describe("registration route policy", () => {
  it("renders the registration client only when server policy allows it", async () => {
    server.registrationEnabled.mockReturnValue(true);

    const result = await Page({
      searchParams: Promise.resolve({ next: "/projects/project_1" }),
    });

    expect(server.connection).toHaveBeenCalledOnce();
    expect(server.registrationEnabled).toHaveBeenCalledOnce();
    expect(server.redirect).not.toHaveBeenCalled();
    expect(result.type).toBe(RegisterPage);
  });

  it("redirects before rendering when server policy closes registration", async () => {
    server.registrationEnabled.mockReturnValue(false);

    await expect(Page({
      searchParams: Promise.resolve({ next: "/projects/project_1?tab=files" }),
    })).rejects.toBe(server.redirectError);

    expect(server.redirect).toHaveBeenCalledWith(
      "/login?next=%2Fprojects%2Fproject_1%3Ftab%3Dfiles",
    );
  });

  it("drops an unsafe return path before redirecting", async () => {
    server.registrationEnabled.mockReturnValue(false);

    await expect(Page({
      searchParams: Promise.resolve({ next: "//attacker.example" }),
    })).rejects.toBe(server.redirectError);

    expect(server.redirect).toHaveBeenCalledWith("/login");
  });
});
