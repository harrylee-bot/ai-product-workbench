// @vitest-environment jsdom

import type { CurrentSubmissionIntent, SubmissionIntent } from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import { useCurrentWorkbenchSubmissionIntent } from "./index";

const mocks = vi.hoisted(() => ({ getCurrentSubmissionIntent: vi.fn() }));
vi.mock("../api-adapter", () => ({ useWorkbenchSubmissionIntentsApi: () => mocks }));
afterEach(() => { vi.clearAllMocks(); });

describe("SubmissionIntent application hooks", () => {
  it("loads current state and enables one-second verification polling", async () => {
    const queryClient = client();
    const verifying = currentIntent("verifying");
    mocks.getCurrentSubmissionIntent.mockResolvedValue(verifying);

    const current = renderHook(
      () => useCurrentWorkbenchSubmissionIntent("thread-1"),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(current.result.current.data).toEqual(verifying));
    expect(mocks.getCurrentSubmissionIntent).toHaveBeenCalledWith(
      "thread-1",
      expect.any(AbortSignal),
    );

    const query = queryClient.getQueryCache().find({
      queryKey: workbenchQueryKeys.currentSubmissionIntent("thread-1"),
    });
    const interval = query ? Reflect.get(query.options, "refetchInterval") : undefined;
    expect(typeof interval).toBe("function");
    if (typeof interval !== "function" || !query) throw new Error("Missing poll interval");
    expect(interval(query)).toBe(1_000);

    current.unmount();
    queryClient.clear();
  });

});

const timestamp = "2026-07-15T00:00:00.000Z";

function pendingIntent(suffix = "1"): SubmissionIntent {
  return {
    id: `intent-${suffix}`,
    projectId: `project-${suffix}`,
    threadId: `thread-${suffix}`,
    status: "pending",
    request: {
      prompt: "Build a dashboard",
      modelId: "quality",
      workflow: "generate",
      generationIntent: null,
      targetSurface: "web",
      designStyle: { kind: "automatic" },
      artifactTargets: [],
      requestedArtifactKinds: [],
      sourceIds: [],
      canvasSnapshot: null,
    },
    attachments: [],
    runId: null,
    lastFailure: null,
    revision: 1,
    submittedAt: null,
    cancelledAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function currentIntent(fileStatus: "verifying"): CurrentSubmissionIntent {
  return {
    item: {
      ...pendingIntent(),
      attachments: [{
        position: 0,
        kind: "upload",
        fileAssetId: "file-1",
        clientFingerprint: "submission-file:fixture-1",
        fileName: "brief.pdf",
        declaredMediaType: "application/pdf",
        byteSize: 42,
        lastModified: 1_786_771_200_000,
        fileStatus,
      }],
    },
  };
}

function client() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapper(queryClient: QueryClient) {
  return function WorkbenchQueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}
