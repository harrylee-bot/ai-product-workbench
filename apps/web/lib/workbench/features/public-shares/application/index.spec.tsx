// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import { publicShareTokenScope } from "../domain";
import { useWorkbenchPublicSharedArtifactContent } from "./index";

const mocks = vi.hoisted(() => ({
  getPublicSharedArtifactVersionContent: vi.fn(),
}));

vi.mock("../api-adapter", () => ({
  useWorkbenchPublicSharesApi: () => mocks,
}));

afterEach(() => {
  mocks.getPublicSharedArtifactVersionContent.mockReset();
});

describe("public shared Artifact content query", () => {
  it("loads immutable bytes while keeping the raw Share token out of the query key", async () => {
    const token = `wbs_${"A".repeat(43)}`;
    const content = new Blob(["shared"], { type: "text/plain" });
    mocks.getPublicSharedArtifactVersionContent.mockResolvedValue(content);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const rendered = renderHook(() => useWorkbenchPublicSharedArtifactContent(
      token,
      "artifact-1",
      "version-1",
    ), { wrapper });

    await waitFor(() => expect(rendered.result.current.data).toBe(content));
    expect(mocks.getPublicSharedArtifactVersionContent).toHaveBeenCalledWith(
      token,
      "artifact-1",
      "version-1",
    );
    const queryKey = workbenchQueryKeys.publicSharedArtifactContent(
      publicShareTokenScope(token),
      "artifact-1",
      "version-1",
    );
    expect(queryClient.getQueryData(queryKey)).toBe(content);
    expect(JSON.stringify(queryKey)).not.toContain(token);

    rendered.unmount();
    queryClient.clear();
  });
});
