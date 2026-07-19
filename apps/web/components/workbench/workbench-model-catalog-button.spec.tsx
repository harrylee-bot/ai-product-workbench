// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "@/lib/workbench/api";
import type { WorkbenchModelCatalogState } from "@/lib/workbench/features";

import { WorkbenchModelCatalogButton } from "./workbench-model-catalog-button";

afterEach(cleanup);

describe("WorkbenchModelCatalogButton", () => {
  it("blocks interaction and announces the initial loading state", () => {
    const onRetry = vi.fn();
    const onToggle = vi.fn();
    renderButton({ error: null, retrying: false, status: "loading" }, { onRetry, onToggle });

    const button = screen.getByRole("button", { name: "正在加载产品工作台模型目录" });
    expect(button.textContent).toContain("正在加载模型");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it.each([
    [502, "模型连接失败，重试"],
    [504, "模型响应超时，重试"],
    [500, "模型加载失败，重试"],
  ])("renders a retry action for an HTTP %i catalog failure", (status, label) => {
    const onRetry = vi.fn();
    const onToggle = vi.fn();
    renderButton({ error: apiError(status), retrying: false, status: "error" }, {
      onRetry,
      onToggle,
    });

    const button = screen.getByRole("button", { name: label });
    expect(button.textContent).toContain(label);
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("blocks duplicate retries while the catalog request is in flight", () => {
    const onRetry = vi.fn();
    renderButton({ error: apiError(504), retrying: true, status: "error" }, { onRetry });

    const button = screen.getByRole("button", { name: "正在重试模型" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("正在重试模型");
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("shows an empty catalog without opening an empty menu", () => {
    const onToggle = vi.fn();
    renderButton({ error: null, retrying: false, status: "empty" }, { onToggle });

    const button = screen.getByRole("button", { name: "产品工作台暂无可用模型" });
    expect(button.textContent).toContain("无可用模型");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("opens the model menu after the catalog recovers", () => {
    const onRetry = vi.fn();
    const onToggle = vi.fn();
    renderButton({ error: null, retrying: false, status: "ready" }, {
      onRetry,
      onToggle,
      selectedLabel: "默认模型",
    });

    const button = screen.getByRole("button", { name: "模型：默认模型" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.textContent).toContain("默认模型");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });
});

function renderButton(
  catalog: WorkbenchModelCatalogState,
  options: {
    onRetry?: () => void;
    onToggle?: () => void;
    selectedLabel?: string;
  } = {},
) {
  return render(
    <WorkbenchModelCatalogButton
      catalog={catalog}
      className="model-button"
      menuOpen={false}
      onRetry={options.onRetry ?? vi.fn()}
      onToggle={options.onToggle ?? vi.fn()}
      selectedLabel={options.selectedLabel}
    />,
  );
}

function apiError(status: number) {
  return new WorkbenchApiError({
    type: "about:blank",
    title: `HTTP ${status}`,
    status,
    code: `HTTP_${status}`,
    detail: `HTTP ${status}`,
  });
}
