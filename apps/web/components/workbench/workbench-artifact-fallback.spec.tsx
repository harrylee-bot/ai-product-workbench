// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorkbenchArtifactFallback,
  WorkbenchDocumentLoading,
  workbenchPendingArtifactTitle,
} from "./workbench-artifact-fallback";

afterEach(cleanup);

describe("Workbench artifact fallback", () => {
  it("renders only a neutral pending state while an artifact is being generated", () => {
    const rendered = render(
      <WorkbenchArtifactFallback
        phase="generating"
        title="会员中心 · 界面 1"
        variant="prototype"
      />,
    );

    expect(screen.getByText("正在生成：会员中心 · 界面 1")).toBeTruthy();
    expect(rendered.container.querySelector('[data-workbench-artifact-state="pending"]')).toBeTruthy();
    expect(rendered.container.querySelector("[data-workbench-artifact-skeleton]")).toBeTruthy();
    expect(screen.queryByText(/打卡|签到|奖励/)).toBeNull();
  });

  it("keeps refinement truthful without presenting generated business content", () => {
    render(
      <WorkbenchArtifactFallback
        phase="refining"
        title="订单详情 · 界面 2"
        variant="prototype"
      />,
    );

    expect(screen.getByText("正在细化：订单详情 · 界面 2")).toBeTruthy();
    expect(screen.queryByText("产物不可用")).toBeNull();
  });

  it("preserves the loading composition and status context for a pending document", () => {
    const rendered = render(
      <WorkbenchDocumentLoading />,
    );

    expect(screen.getByText("正在生成：需求文档")).toBeTruthy();
    expect(rendered.container.querySelector("[data-workbench-artifact-skeleton]")).toBeTruthy();
    expect(rendered.container.querySelector(".workbench-artifact-spinner")).toBeTruthy();
    expect(rendered.container.querySelector(".animate-spin")).toBeNull();
    expect(rendered.container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it("distinguishes a refining document from first-generation loading", () => {
    render(<WorkbenchDocumentLoading phase="refining" />);

    expect(screen.getByText("正在细化：需求文档")).toBeTruthy();
    expect(screen.queryByText("正在生成：需求文档")).toBeNull();
  });

  it("uses a non-blocking status without a skeleton while refreshing readable content", () => {
    const rendered = render(<WorkbenchDocumentLoading mode="refresh" phase="refining" />);

    expect(screen.getByRole("status").textContent).toContain("正在细化：需求文档");
    expect(rendered.container.querySelector('[data-workbench-artifact-state="refreshing"]'))
      .toBeTruthy();
    expect(rendered.container.querySelector("[data-workbench-artifact-skeleton]")).toBeNull();
  });

  it("fails closed when a completed node has no persisted artifact", () => {
    const rendered = render(
      <WorkbenchArtifactFallback
        phase="complete"
        title="结算流程 · 需求文档"
        variant="document"
      />,
    );

    expect(screen.getByText("产物不可用")).toBeTruthy();
    expect(screen.getByText("结算流程 · 需求文档 尚无可用的持久化版本，请重新运行生成。")).toBeTruthy();
    expect(rendered.container.querySelector('[data-workbench-artifact-state="unavailable"]')).toBeTruthy();
    expect(rendered.container.querySelector("[data-workbench-artifact-skeleton]")).toBeNull();
  });

  it("derives bounded node titles from the current prompt", () => {
    expect(workbenchPendingArtifactTitle("  创建\n会员中心  ", "document"))
      .toBe("创建 会员中心 · 需求文档");
    expect(workbenchPendingArtifactTitle("", "prototype", 2))
      .toBe("当前请求 · 界面 3");
    expect(workbenchPendingArtifactTitle("一".repeat(40), "prototype", 0))
      .toBe(`${"一".repeat(36)}... · 界面 1`);
  });
});
