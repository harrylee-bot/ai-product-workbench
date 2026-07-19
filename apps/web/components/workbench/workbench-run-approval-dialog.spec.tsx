// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchRunApprovalDialog } from "./workbench-run-approval-dialog";

const approval = {
  id: "approval-1",
  runId: "run-1",
  key: "layout",
  kind: "choice",
  prompt: "请选择布局",
  options: [
    { id: "compact", label: "紧凑", description: "高信息密度", value: "compact" },
    { id: "spacious", label: "宽松", description: null, value: { layout: "spacious" } },
  ],
  attempt: 0,
  status: "pending" as const,
  response: null,
  decidedById: null,
  decidedAt: null,
  revision: 0,
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

afterEach(() => cleanup());

describe("WorkbenchRunApprovalDialog", () => {
  it("uses a real radio group and submits the selected structured value", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <WorkbenchRunApprovalDialog
        approval={approval}
        busy={false}
        error={null}
        onSubmit={onSubmit}
      />,
    );

    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(2);
    expect(options[0]?.getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("radio", { name: /宽松/u }));
    await user.click(screen.getByRole("button", { name: "确认选择" }));

    expect(onSubmit).toHaveBeenCalledWith("submit", { layout: "spacious" });
  });

  it("submits a plain approval when no options are present", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <WorkbenchRunApprovalDialog
        approval={{ ...approval, options: [] }}
        busy={false}
        error={null}
        onSubmit={onSubmit}
      />,
    );

    await user.click(screen.getByRole("button", { name: "批准" }));
    expect(onSubmit).toHaveBeenCalledWith("approve");
  });

  it("traps keyboard focus and restores it when the blocking approval closes", async () => {
    const user = userEvent.setup();
    const opener = document.createElement("button");
    opener.textContent = "打开审批";
    document.body.append(opener);
    opener.focus();
    const rendered = render(
      <WorkbenchRunApprovalDialog
        approval={approval}
        busy={false}
        error={null}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    const options = screen.getAllByRole("radio");
    await waitFor(() => expect(document.activeElement).toBe(options[0]));
    await user.keyboard("{ArrowDown}");
    const selectedOption = screen.getByRole("radio", { name: /宽松/u });
    expect(document.activeElement).toBe(selectedOption);
    await user.keyboard(" ");
    await waitFor(() => expect(
      screen.getByRole("radio", { name: /宽松/u }).getAttribute("aria-checked"),
    ).toBe("true"));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "拒绝" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "确认选择" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /宽松/u }));

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "需要您的确认" })).toBeTruthy();
    rendered.unmount();
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });
});
