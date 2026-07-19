// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchAccountMenu } from "./workbench-account-menu";

afterEach(cleanup);

describe("WorkbenchAccountMenu", () => {
  it("shows the authenticated identity and executes Better Auth logout", async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    const userEventDriver = userEvent.setup();
    render(
      <WorkbenchAccountMenu
        onLogout={logout}
        user={{ id: "user-1", name: "李雷", email: "lilei@example.com" }}
      />,
    );

    await userEventDriver.click(screen.getByRole("button", { name: "李雷账户" }));
    expect(await screen.findByText("lilei@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
  });
});
