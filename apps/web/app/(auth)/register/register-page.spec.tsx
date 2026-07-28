// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock("@/lib/auth/workbench-auth", () => ({
  useWorkbenchAuth: () => auth,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("next=/projects/project_1"),
}));

import { RegisterPage } from "./register-page";

afterEach(() => {
  auth.register.mockReset();
  cleanup();
});

describe("product account registration page", () => {
  it("renders the product-account form", () => {
    render(<RegisterPage />);

    expect(screen.getByLabelText("用户名")).toBeTruthy();
    expect(screen.getByLabelText("邮箱")).toBeTruthy();
    expect(screen.getByLabelText("密码")).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建工作台" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "登录继续" }).getAttribute("href"))
      .toBe("/login?next=%2Fprojects%2Fproject_1");
  });

  it("submits valid product account details through the auth client", async () => {
    const driver = userEvent.setup();
    auth.register.mockRejectedValueOnce(new Error("expected test rejection"));
    render(<RegisterPage />);

    await driver.type(screen.getByLabelText("用户名"), "Product.Owner");
    await driver.type(screen.getByLabelText("邮箱"), "owner@example.test");
    await driver.type(screen.getByLabelText("密码"), "Password1!");
    await driver.click(screen.getByRole("button", { name: "创建工作台" }));

    await waitFor(() => expect(auth.register).toHaveBeenCalledWith({
      username: "Product.Owner",
      email: "owner@example.test",
      password: "Password1!",
    }));
  });
});
