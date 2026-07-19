// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import { useWorkbenchDesignPresets } from "./index";

const mocks = vi.hoisted(() => ({
  listDesignPresets: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchDesignPresetsApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Design Preset catalog", () => {
  it("loads the global catalog through the feature adapter", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mocks.listDesignPresets.mockResolvedValue({ items: [] });
    const rendered = renderHook(() => useWorkbenchDesignPresets(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true));

    expect(mocks.listDesignPresets).toHaveBeenCalledOnce();
    expect(rendered.result.current.data).toEqual({ items: [] });
    expect(workbenchQueryKeys.designPresets()).toEqual(["workbench", "design-presets"]);
    expect(queryClient.getQueryState(workbenchQueryKeys.designPresets())?.status)
      .toBe("success");
    rendered.unmount();
    queryClient.clear();
  });
});
