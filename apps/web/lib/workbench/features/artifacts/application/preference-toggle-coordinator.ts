import type {
  ArtifactVersionPreference,
  UpdateArtifactVersionPreferenceRequest,
} from "@workbench/workbench-contracts";

export type ArtifactPreferenceToggleAction = "dislike" | "favorite" | "like";

export class ArtifactPreferenceToggleCoordinator {
  readonly #preferences = new Map<string, ArtifactVersionPreference>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #refreshRequired = new Set<string>();

  hydrate(targetKey: string, preference: ArtifactVersionPreference): void {
    this.#store(targetKey, preference);
  }

  #store(targetKey: string, preference: ArtifactVersionPreference): boolean {
    const current = this.#preferences.get(targetKey);
    if (!current || preference.revision >= current.revision) {
      this.#preferences.set(targetKey, preference);
      return true;
    }
    return false;
  }

  #hydrateAuthoritative(targetKey: string, preference: ArtifactVersionPreference): void {
    if (this.#store(targetKey, preference)) this.#refreshRequired.delete(targetKey);
  }

  enqueue(
    targetKey: string,
    action: ArtifactPreferenceToggleAction,
    fallback: ArtifactVersionPreference | null,
    update: (
      request: UpdateArtifactVersionPreferenceRequest,
    ) => Promise<ArtifactVersionPreference>,
    refresh: () => Promise<ArtifactVersionPreference | null>,
  ): Promise<void> {
    const previous = this.#queues.get(targetKey) ?? Promise.resolve();
    const task = previous.then(async () => {
      let preference = this.#preferences.get(targetKey) ?? fallback;
      if (this.#refreshRequired.has(targetKey)) {
        preference = await refresh();
        if (!preference) throw new Error("ARTIFACT_PREFERENCE_REFRESH_REQUIRED");
        this.#hydrateAuthoritative(targetKey, preference);
      }
      if (!preference) return;
      try {
        const updated = await update(toggleRequest(preference, action));
        this.#hydrateAuthoritative(targetKey, updated);
      } catch (error) {
        this.#refreshRequired.add(targetKey);
        try {
          const refreshed = await refresh();
          if (refreshed) this.#hydrateAuthoritative(targetKey, refreshed);
        } catch {
          // The next queued action must refresh again before it can mutate.
        }
        throw error;
      }
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
