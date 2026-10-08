// @vitest-environment jsdom

import type { ArtifactFinalization } from "@workbench/workbench-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { workbenchQueryKeys } from "../../../query/keys";
import { useUpdateWorkbenchArtifactFinalization, useWorkbenchArtifactFinalization } from "./index";

const api = vi.hoisted(() => ({
  getFinalization: vi.fn(),
  confirmFinalization: vi.fn(),
  retryFinalization: vi.fn(),
  withdrawFinalization: vi.fn(),
}));

vi.mock("../api-adapter", () => ({ useWorkbenchArtifactsApi: () => api }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const checksum = "a".repeat(64);
const state: ArtifactFinalization = {
  id: "finalization-1",
  projectId: "project-1",
  artifactVersionId: "version-1",
  confirmedById: "principal-1",
  checksum,
  status: "ingesting",
  confirmedAt: "2026-09-24T00:00:00.000Z",
  withdrawnAt: null,
  ingestionJob: null,
};

function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

function key(versionId: string) {
  return [...workbenchQueryKeys.artifactVersion("project-1", "artifact-1", versionId), "finalization"];
}

describe("Artifact finalization hooks", () => {
  it("does not request owner-only state while disabled, and preserves an unconfirmed null state", async () => {
    api.getFinalization.mockResolvedValue(null);
    const { client, wrapper } = harness();
    const hook = renderHook(({ enabled }) => (
      useWorkbenchArtifactFinalization("project-1", "artifact-1", "version-1", enabled)
    ), { wrapper, initialProps: { enabled: false } });
    expect(api.getFinalization).not.toHaveBeenCalled();

    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.data).toBeNull();
    expect(api.getFinalization).toHaveBeenCalledWith("artifact-1", "version-1");
    hook.unmount();
    client.clear();
  });

  it.each(["confirm", "retry", "withdraw"] as const)("pins %s to the requested version and updates its state", async (kind) => {
    const method = kind === "confirm" ? api.confirmFinalization
      : kind === "retry" ? api.retryFinalization : api.withdrawFinalization;
    method.mockResolvedValue(state);
    const { client, wrapper } = harness();
    const hook = renderHook(() => (
      useUpdateWorkbenchArtifactFinalization("project-1", "artifact-1", "version-1")
    ), { wrapper });
    await act(async () => {
      await hook.result.current.mutateAsync(kind === "confirm" ? { kind, checksum } : { kind });
    });
    expect(method.mock.calls).toEqual([kind === "confirm"
      ? ["artifact-1", "version-1", checksum]
      : ["artifact-1", "version-1"]]);
    expect(client.getQueryData(key("version-1"))).toEqual(state);
    expect(client.getQueryState(key("version-1"))?.isInvalidated).toBe(true);
    hook.unmount();
    client.clear();
  });

  it("does not write a delayed confirmation into another selected version", async () => {
    let resolve!: (value: ArtifactFinalization) => void;
    api.confirmFinalization.mockReturnValue(new Promise<ArtifactFinalization>((done) => { resolve = done; }));
    const { client, wrapper } = harness();
    client.setQueryData(key("version-2"), null);
    const hook = renderHook(({ versionId }) => (
      useUpdateWorkbenchArtifactFinalization("project-1", "artifact-1", versionId)
    ), { wrapper, initialProps: { versionId: "version-1" } });
    let pending!: Promise<ArtifactFinalization | null>;
    act(() => {
      pending = hook.result.current.mutateAsync({ kind: "confirm", checksum });
    });
    await waitFor(() => expect(api.confirmFinalization).toHaveBeenCalledOnce());
    hook.rerender({ versionId: "version-2" });
    await act(async () => {
      resolve(state);
      await pending;
    });
    expect(client.getQueryData(key("version-1"))).toEqual(state);
    expect(client.getQueryData(key("version-2"))).toBeNull();
    hook.unmount();
    client.clear();
  });
});
