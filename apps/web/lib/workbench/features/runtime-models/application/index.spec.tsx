// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  runtimeModelsQueryOptions,
  useWorkbenchRuntimeModels,
} from "./index";

const mocks = vi.hoisted(() => ({
  listRuntimeModels: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchRuntimeModelsApi: () => mocks,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("Runtime Model catalog query", () => {
  it("keeps the shared query key and delegates loading to the feature adapter", async () => {
    const catalog = { items: [model()] };
    mocks.listRuntimeModels.mockResolvedValue(catalog);
    const options = runtimeModelsQueryOptions(mocks);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rendered = renderHook(() => useWorkbenchRuntimeModels(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });

    expect(options.queryKey).toEqual(workbenchQueryKeys.runtimeModels());
    await waitFor(() => expect(rendered.result.current.data).toEqual(catalog));
    expect(mocks.listRuntimeModels).toHaveBeenCalledOnce();
    rendered.unmount();
    queryClient.clear();
  });
});

function model() {
  return {
    id: "quality",
    displayName: "Quality model",
    description: null,
    supportedWorkflows: ["generate", "redesign", "ideate", "edit"] as const,
    supportsThinking: true,
    supportsReasoningEffort: false,
  };
}
