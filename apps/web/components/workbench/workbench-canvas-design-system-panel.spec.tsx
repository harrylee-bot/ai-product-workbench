// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WorkbenchCanvasDesignSystemPanel,
  type WorkbenchCanvasDesignSystemDraft,
} from "./workbench-canvas-design-system-panel";

afterEach(cleanup);

describe("Workbench Canvas Design system panel", () => {
  it("emits structured theme, radius, motion and color edits", () => {
    const onChange = vi.fn();
    const draft = styleDraft();
    const rendered = render(
      <WorkbenchCanvasDesignSystemPanel
        draft={draft}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("产品工作台深色画布")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "切换主题" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...draft, theme: "light" });

    fireEvent.change(screen.getByRole("spinbutton", { name: "圆角" }), {
      target: { value: "18" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...draft, radius: 18 });

    fireEvent.click(screen.getByRole("switch", { name: "Motion" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...draft, motionEnabled: false });

    fireEvent.click(screen.getByRole("button", { name: "颜色 #8758f6" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...draft, color: "#8758f6" });

    rendered.rerender(
      <WorkbenchCanvasDesignSystemPanel
        draft={{ ...draft, color: "#8758f6" }}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "颜色 #8758f6" }).getAttribute("aria-pressed"))
      .toBe("true");
  });

  it("closes through the existing icon command and locks edits while saving", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkbenchCanvasDesignSystemPanel
        busy
        draft={styleDraft()}
        onChange={onChange}
        onClose={onClose}
      />,
    );

    expect(screen.getByLabelText("Design system").getAttribute("aria-busy")).toBe("true");
    expect((screen.getByRole("button", { name: "关闭 Design system" }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "切换主题" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a read-only panel dismissible while locking every write control", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkbenchCanvasDesignSystemPanel
        draft={styleDraft()}
        onChange={onChange}
        onClose={onClose}
        readOnly
      />,
    );

    expect(screen.getByLabelText("Design system").getAttribute("aria-readonly")).toBe("true");
    expect((screen.getByRole("button", { name: "切换主题" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("spinbutton", { name: "圆角" }) as HTMLInputElement).disabled)
      .toBe(true);
    expect((screen.getByRole("switch", { name: "Motion" }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "关闭 Design system" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a recoverable error without changing the panel geometry", () => {
    render(
      <WorkbenchCanvasDesignSystemPanel
        draft={styleDraft()}
        error="样式保存失败，请重试"
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("样式保存失败，请重试");
    expect(screen.getByLabelText("Design system").classList.contains("w-[292px]")).toBe(true);
  });
});

function styleDraft(): WorkbenchCanvasDesignSystemDraft {
  return {
    theme: "dark",
    radius: 10,
    motionEnabled: true,
    color: "#121315",
  };
}
