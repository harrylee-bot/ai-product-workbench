import type { ArtifactVersionPreference } from "@workbench/workbench-contracts";
import { describe, expect, it, vi } from "vitest";

import { ArtifactPreferenceToggleCoordinator } from "./preference-toggle-coordinator";

describe("ArtifactPreferenceToggleCoordinator", () => {
  it("serializes one target and advances each toggle from the previous response", async () => {
    const coordinator = new ArtifactPreferenceToggleCoordinator();
    const requests: Array<{ favorite: boolean; reaction: string | null }> = [];
    const update = vi.fn(async (request) => {
      requests.push(request);
      return preference({ ...request, revision: requests.length });
    });

    const refresh = vi.fn(async () => preference());
    const first = coordinator.enqueue("screen-a", "favorite", preference(), update, refresh);
    const second = coordinator.enqueue("screen-a", "like", preference(), update, refresh);
    await Promise.all([first, second]);

    expect(requests).toEqual([
      { favorite: true, reaction: null },
      { favorite: true, reaction: "like" },
    ]);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("isolates slow responses and state between immutable target keys", async () => {
    const coordinator = new ArtifactPreferenceToggleCoordinator();
    let resolveA: ((value: ArtifactVersionPreference) => void) | null = null;
    const requestsA: Array<{ favorite: boolean; reaction: string | null }> = [];
    const requestsB: Array<{ favorite: boolean; reaction: string | null }> = [];
    const updateA = vi.fn((request) => {
      requestsA.push(request);
      return new Promise<ArtifactVersionPreference>((resolve) => {
        resolveA = resolve;
      });
    });
    const updateB = vi.fn(async (request) => {
      requestsB.push(request);
      return preference({
        artifactId: "artifact-b",
        artifactVersionId: "version-b",
        ...request,
        revision: requestsB.length,
      });
    });

    const refresh = vi.fn(async () => preference());
    const slowA = coordinator.enqueue("screen-a", "favorite", preference(), updateA, refresh);
    await coordinator.enqueue("screen-b", "like", preference({
      artifactId: "artifact-b",
      artifactVersionId: "version-b",
    }), updateB, refresh);
    resolveA!(preference({ favorite: true, revision: 1 }));
    await slowA;
    await coordinator.enqueue("screen-b", "favorite", null, updateB, refresh);

    expect(requestsA).toEqual([{ favorite: true, reaction: null }]);
    expect(requestsB).toEqual([
      { favorite: false, reaction: "like" },
      { favorite: true, reaction: "like" },
    ]);
  });

  it("refreshes and rebases queued toggles after a failed compare-and-swap", async () => {
    const coordinator = new ArtifactPreferenceToggleCoordinator();
    const refreshed = preference({
      favorite: true,
      reaction: "like",
      revision: 4,
    });
    const requests: Array<{ favorite: boolean; reaction: string | null }> = [];
    const update = vi.fn(async (request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error("PRECONDITION_FAILED");
      return preference({ ...request, revision: 5 });
    });
    const refresh = vi.fn(async () => refreshed);

    const first = coordinator.enqueue(
      "screen-a",
      "favorite",
      preference({ revision: 3 }),
      update,
      refresh,
    );
    const firstFailure = first.catch((error: unknown) => error);
    const second = coordinator.enqueue(
      "screen-a",
      "dislike",
      preference({ revision: 3 }),
      update,
      refresh,
    );

    await second;
    expect(await firstFailure).toEqual(new Error("PRECONDITION_FAILED"));
    expect(refresh).toHaveBeenCalledOnce();
    expect(requests).toEqual([
      { favorite: true, reaction: null },
      { favorite: true, reaction: "dislike" },
    ]);
  });

  it("blocks later queued writes while authoritative refresh is unavailable", async () => {
    const coordinator = new ArtifactPreferenceToggleCoordinator();
    const update = vi.fn()
      .mockRejectedValueOnce(new Error("PRECONDITION_FAILED"))
      .mockResolvedValue(preference({ revision: 5 }));
    const refresh = vi.fn().mockRejectedValue(new Error("refresh unavailable"));

    const first = coordinator.enqueue(
      "screen-a",
      "favorite",
      preference({ revision: 3 }),
      update,
      refresh,
    );
    const firstFailure = first.catch((error: unknown) => error);
    expect(await firstFailure).toEqual(new Error("PRECONDITION_FAILED"));
    coordinator.hydrate("screen-a", preference({ revision: 3 }));
    const second = coordinator.enqueue(
      "screen-a",
      "like",
      preference({ revision: 3 }),
      update,
      refresh,
    );

    await expect(second).rejects.toThrow("refresh unavailable");
    expect(update).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

function preference(
  overrides: Partial<ArtifactVersionPreference> = {},
): ArtifactVersionPreference {
  const revision = overrides.revision ?? 0;
  return {
    artifactId: "artifact-a",
    artifactVersionId: "version-a",
    screenId: "screen-a",
    favorite: false,
    reaction: null,
    revision,
    createdAt: revision === 0 ? null : "2026-07-17T00:00:00.000Z",
    updatedAt: revision === 0 ? null : "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}
