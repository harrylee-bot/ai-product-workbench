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
  WorkbenchQueryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/workbench/transport", () => ({
  WorkbenchTransportProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("./share-view", () => ({
  ShareView: () => <div>分享内容</div>,
}));

beforeEach(() => {
  mocks.publicShare.mockReset();
});

afterEach(cleanup);

describe("Public Share error states", () => {
  it.each([404, 410])("treats HTTP %s as an invalid or expired share", (status) => {
    mocks.publicShare.mockReturnValue(errorQuery(apiError(status)));

    render(<ShareClient token="public-token" />);

    expect(screen.getByText("分享链接无效或已失效")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it.each([
    ["authorization failure", apiError(403)],
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
