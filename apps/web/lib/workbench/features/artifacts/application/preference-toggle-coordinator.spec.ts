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

    const first = coordinator.enqueue("screen-a", "favorite", preference(), update);
    const second = coordinator.enqueue("screen-a", "like", preference(), update);
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

    const slowA = coordinator.enqueue("screen-a", "favorite", preference(), updateA);
    await coordinator.enqueue("screen-b", "like", preference({
      artifactId: "artifact-b",
      artifactVersionId: "version-b",
    }), updateB);
    resolveA!(preference({ favorite: true, revision: 1 }));
    await slowA;
    await coordinator.enqueue("screen-b", "favorite", null, updateB);

    expect(requestsA).toEqual([{ favorite: true, reaction: null }]);
    expect(requestsB).toEqual([
      { favorite: false, reaction: "like" },
      { favorite: true, reaction: "like" },
    ]);
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
