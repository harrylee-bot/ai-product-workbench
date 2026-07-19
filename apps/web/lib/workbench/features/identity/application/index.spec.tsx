// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  useWorkbenchIdentity,
  useWorkbenchIdentityReader,
} from "./index";

const mocks = vi.hoisted(() => ({
  getIdentity: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchIdentityApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Identity application", () => {
  it("loads the principal under the stable identity key", async () => {
    const principal = { id: "principal-1", defaultWorkspaceId: "workspace-1" };
    mocks.getIdentity.mockResolvedValue(principal);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rendered = renderHook(() => useWorkbenchIdentity(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => expect(rendered.result.current.data).toBe(principal));
    expect(queryClient.getQueryData(workbenchQueryKeys.identity())).toBe(principal);
    rendered.unmount();
    queryClient.clear();
  });

  it("passes the feature-owned adapter directly to lazy Share remix reads", () => {
    const rendered = renderHook(() => useWorkbenchIdentityReader());

    expect(rendered.result.current).toBe(mocks);
    expect(mocks.getIdentity).not.toHaveBeenCalled();
    rendered.unmount();
  });
});
