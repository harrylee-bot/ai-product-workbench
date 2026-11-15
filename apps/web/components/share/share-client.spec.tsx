// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkbenchApiError } from "@/lib/workbench/api";
import { ShareClient } from "./share-client";

const mocks = vi.hoisted(() => ({
  publicShare: vi.fn(),
}));

vi.mock("@/lib/workbench/features", () => ({
  useWorkbenchPublicShare: mocks.publicShare,
}));

vi.mock("@/lib/workbench/query", () => ({
  WorkbenchQueryProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/lib/workbench/transport", () => ({
  WorkbenchTransportProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/studio/public-release", () => ({
  PublicRelease: () => <div>分享内容</div>,
}));

beforeEach(() => {
  mocks.publicShare.mockReset();
});

afterEach(cleanup);

describe("Public Share error states", () => {
  it.each([404, 410])(
    "treats HTTP %s as an invalid or expired share",
    (status) => {
      mocks.publicShare.mockReturnValue(errorQuery(apiError(status)));

      render(<ShareClient token="public-token" />);

      expect(screen.getByText("分享链接无效")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    },
  );

  it.each([
    ["server failure", apiError(502)],
    ["network failure", new TypeError("Failed to fetch")],
  ])("shows a retryable service state for a %s", (_label, error) => {
    const refetch = vi.fn();
    mocks.publicShare.mockReturnValue(errorQuery(error, refetch));

    render(<ShareClient token="public-token" />);

    expect(screen.getByText("分享服务暂不可用，请稍后重试")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["SHARE_EXPIRED", "分享已过期"],
    ["SHARE_REVOKED", "分享已撤销"],
  ])("clears a cached release when the service reports %s", (code, label) => {
    const query = errorQuery(
      new WorkbenchApiError({
        type: "about:blank",
        title: "Private details must stay hidden",
        status: 404,
        code,
        detail: "/private/storage/path",
      }),
    );
    mocks.publicShare.mockReturnValue({
      ...query,
      data: { value: { shareId: "cached" } },
    });
    render(<ShareClient token="public-token" />);
    expect(screen.getByRole("heading", { name: label })).toBeTruthy();
    expect(screen.queryByText("分享内容")).toBeNull();
    expect(screen.queryByText(/private/)).toBeNull();
  });

  it("distinguishes permission and unavailable preview errors without exposing server detail", () => {
    mocks.publicShare.mockReturnValue(errorQuery(apiError(403)));
    const view = render(<ShareClient token="public-token" />);
    expect(
      screen.getByRole("heading", { name: "无法访问此分享" }),
    ).toBeTruthy();
    mocks.publicShare.mockReturnValue(
      errorQuery(
        new WorkbenchApiError({
          type: "about:blank",
          title: "Preview",
          status: 409,
          code: "SHARE_PREVIEW_UNAVAILABLE",
          detail: "private-path",
        }),
      ),
    );
    view.rerender(<ShareClient token="public-token" />);
    expect(screen.getByRole("heading", { name: "暂无可用预览" })).toBeTruthy();
    expect(screen.queryByText("private-path")).toBeNull();
  });
});

function errorQuery(error: unknown, refetch = vi.fn()) {
  return {
    data: undefined,
    error,
    isError: true,
    isPending: false,
    refetch,
  };
}

function apiError(status: number) {
  return new WorkbenchApiError({
    type: "about:blank",
    title: `HTTP ${status}`,
    status,
    code: `HTTP_${status}`,
  });
}
