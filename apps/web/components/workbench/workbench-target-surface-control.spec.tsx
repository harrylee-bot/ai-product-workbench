// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchTargetSurfaceControl } from "./workbench-target-surface-control";

afterEach(cleanup);

describe("产品工作台生成目标控件", () => {
  it("reports a changed target surface", async () => {
    const onChange = vi.fn();
    render(
      <WorkbenchTargetSurfaceControl
        onChange={onChange}
        surface="app"
      />,
    );

    expect(screen.getByRole("button", { name: "应用" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Web" }));

    expect(onChange).toHaveBeenCalledWith("web");
  });

  it("does not allow changing the target while disabled", async () => {
    const onChange = vi.fn();
    render(
      <WorkbenchTargetSurfaceControl
        disabled
        onChange={onChange}
        surface="web"
        variant="panel"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "应用" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Web" }).getAttribute("aria-pressed")).toBe("true");
  });
});
