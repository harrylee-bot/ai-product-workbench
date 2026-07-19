// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "@/lib/workbench/api";
import { HomeProjectList, ProjectLoadStatus } from "@/lib/workbench/features/projects";

afterEach(cleanup);

describe("Workbench query load states", () => {
  it("renders a retryable Project-list error instead of an empty-list result", () => {
    const retry = vi.fn();
    render(
      <HomeProjectList
        actionBusy={false}
        error={apiError(500, "项目服务暂时不可用")}
        hasNextPage={false}
        isFetchingNextPage={false}
        loadStatus="error"
        onArchiveProject={vi.fn()}
        onDuplicateProject={vi.fn()}
        onLoadMore={vi.fn()}
        onOpenProject={vi.fn()}
        onRetry={retry}
        projects={[]}
      />,
    );

    expect(screen.getByText("项目服务暂时不可用")).toBeTruthy();
    expect(screen.queryByText("没有匹配的项目")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("distinguishes Project loading, not-found, and retryable server failures", () => {
    const retry = vi.fn();
    const rendered = render(
      <ProjectLoadStatus error={null} onRetry={retry} status="loading" />,
    );
    expect(screen.getByText("正在加载项目...")).toBeTruthy();

    rendered.rerender(
      <ProjectLoadStatus error={apiError(404, "Not found")} onRetry={retry} status="error" />,
    );
    expect(screen.getByText("项目不存在，或您已没有访问权限。")).toBeTruthy();

    rendered.rerender(
      <ProjectLoadStatus error={apiError(500, "项目加载暂时失败")} onRetry={retry} status="error" />,
    );
    expect(screen.getByText("项目加载暂时失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

function apiError(status: number, detail: string) {
  return new WorkbenchApiError({
    type: "about:blank",
    title: detail,
    status,
    code: `HTTP_${status}`,
    detail,
  });
}
