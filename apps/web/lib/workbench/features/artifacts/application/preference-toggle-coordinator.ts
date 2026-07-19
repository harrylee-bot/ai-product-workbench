import type {
  ArtifactVersionPreference,
  UpdateArtifactVersionPreferenceRequest,
} from "@workbench/workbench-contracts";

export type ArtifactPreferenceToggleAction = "dislike" | "favorite" | "like";

export class ArtifactPreferenceToggleCoordinator {
  readonly #preferences = new Map<string, ArtifactVersionPreference>();
  readonly #queues = new Map<string, Promise<void>>();

  hydrate(targetKey: string, preference: ArtifactVersionPreference): void {
    const current = this.#preferences.get(targetKey);
    if (!current || preference.revision >= current.revision) {
      this.#preferences.set(targetKey, preference);
    }
  }

  enqueue(
    targetKey: string,
    action: ArtifactPreferenceToggleAction,
    fallback: ArtifactVersionPreference | null,
    update: (
      request: UpdateArtifactVersionPreferenceRequest,
    ) => Promise<ArtifactVersionPreference>,
  ): Promise<void> {
    const previous = this.#queues.get(targetKey) ?? Promise.resolve();
    const task = previous.then(async () => {
      const preference = this.#preferences.get(targetKey) ?? fallback;
      if (!preference) return;
      const updated = await update(toggleRequest(preference, action));
      this.hydrate(targetKey, updated);
    });
    const settled = task.catch(() => undefined);
    this.#queues.set(targetKey, settled);
    void settled.finally(() => {
      if (this.#queues.get(targetKey) === settled) this.#queues.delete(targetKey);
    });
    return task;
  }
}

function toggleRequest(
  preference: ArtifactVersionPreference,
  action: ArtifactPreferenceToggleAction,
): UpdateArtifactVersionPreferenceRequest {
  return {
    favorite: action === "favorite" ? !preference.favorite : preference.favorite,
    reaction: action === "favorite"
      ? preference.reaction
      : preference.reaction === action ? null : action,
  };
}
