// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  login: vi.fn(),
  loginWithOidc: vi.fn(),
}));

vi.mock("@/lib/auth/workbench-auth", () => ({
  useWorkbenchAuth: () => auth,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("next=/projects/project_1?tab=files"),
}));

import { LoginPage } from "./login-page";

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED", "true");
});

afterEach(() => {
  auth.login.mockReset();
  auth.loginWithOidc.mockReset();
  cleanup();
  vi.unstubAllEnvs();
});

describe("product account login page", () => {
  it("shows product credentials and optional SSO without starting a redirect", () => {
    render(<LoginPage enterpriseSsoEnabled />);

    expect(screen.getByLabelText("用户名或邮箱")).toBeTruthy();
    expect(screen.getByLabelText("密码")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^登录/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "企业 SSO 登录" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "创建一个" }).getAttribute("href"))
      .toBe("/register?next=%2Fprojects%2Fproject_1%3Ftab%3Dfiles");
    expect(auth.login).not.toHaveBeenCalled();
    expect(auth.loginWithOidc).not.toHaveBeenCalled();
  });

  it("hides self-registration when production policy is closed", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKBENCH_PUBLIC_REGISTRATION_ENABLED", "false");
    render(<LoginPage enterpriseSsoEnabled />);

    expect(screen.queryByRole("link", { name: "创建一个" })).toBeNull();
    expect(screen.getByLabelText("用户名或邮箱")).toBeTruthy();
  });

  it("hides the enterprise SSO entry when it is not configured", () => {
    render(<LoginPage enterpriseSsoEnabled={false} />);

    expect(screen.getByLabelText("用户名或邮箱")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "企业 SSO 登录" })).toBeNull();
  });

  it("submits a username directly and only redirects when SSO is selected", async () => {
    const driver = userEvent.setup();
    auth.login.mockRejectedValueOnce(new Error("expected test rejection"));
    auth.loginWithOidc.mockResolvedValueOnce(undefined);
    render(<LoginPage enterpriseSsoEnabled />);

    await driver.type(screen.getByLabelText("用户名或邮箱"), "Product.Owner");
    await driver.type(screen.getByLabelText("密码"), "Password1!");
    await driver.click(screen.getByRole("button", { name: /^登录/ }));
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith({
      account: "Product.Owner",
      password: "Password1!",
    }));
    expect(auth.loginWithOidc).not.toHaveBeenCalled();

    await driver.click(screen.getByRole("button", { name: "企业 SSO 登录" }));
    await waitFor(() => expect(auth.loginWithOidc).toHaveBeenCalledWith(
      "/projects/project_1?tab=files",
    ));
  });
});
