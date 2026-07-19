import type { Board } from "@workbench/workbench-contracts";

import type { BoardSaveSnapshot, BoardStore } from "../../../board/store";

export type BoardAutosaveResult = {
  value: Board;
  etag?: string;
};

export type BoardAutosaveSave = (snapshot: BoardSaveSnapshot) => Promise<BoardAutosaveResult>;

export type BoardAutosaveEventTarget = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

export type BoardAutosaveVisibilityTarget = BoardAutosaveEventTarget & {
  readonly visibilityState: string;
};

export type BoardAutosaveCoordinatorOptions = {
  store: BoardStore;
  save: BoardAutosaveSave;
  onSaved?: (result: BoardAutosaveResult, snapshot: BoardSaveSnapshot) => void | Promise<void>;
  debounceMs?: number;
  visibilityTarget?: BoardAutosaveVisibilityTarget | null;
  pageLifecycleTarget?: BoardAutosaveEventTarget | null;
};

export type BoardAutosaveCoordinatorState = {
  disposed: boolean;
  inFlight: boolean;
  paused: boolean;
  pending: boolean;
};

export type BoardAutosaveCoordinator = {
  dispose: () => Promise<void>;
  flush: () => Promise<void>;
  getState: () => BoardAutosaveCoordinatorState;
  resume: () => boolean;
  setSave: (save: BoardAutosaveSave) => void;
};

export function createBoardAutosaveCoordinator({
  store,
  save,
  onSaved,
  debounceMs = 600,
  visibilityTarget = defaultVisibilityTarget(),
  pageLifecycleTarget = defaultPageLifecycleTarget(),
}: BoardAutosaveCoordinatorOptions): BoardAutosaveCoordinator {
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError("Board autosave debounceMs must be a non-negative finite number");
  }

  let saveCallback = save;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let drainPromise: Promise<void> | null = null;
  let flushRequested = false;
  let paused = store.getState().saveStatus === "error" || store.getState().saveStatus === "conflict";
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  let disposing = false;
  let observedEditVersion = store.getState().editVersion;

  const clearDebounce = () => {
    if (debounceTimer === null) return;
    clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  const pause = () => {
    paused = true;
    flushRequested = false;
    clearDebounce();
  };

  const schedule = () => {
    if (disposed || paused) return;
    const state = store.getState();
    if (!state.dirty || state.saveStatus === "error" || state.saveStatus === "conflict") return;
    clearDebounce();
    if (disposing) {
      void requestFlush();
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void requestFlush();
    }, debounceMs);
  };

  const drain = async () => {
    while (!disposed && !paused && flushRequested) {
      flushRequested = false;
      const before = store.getState();
      if (before.saveStatus === "error" || before.saveStatus === "conflict") {
        pause();
        return;
      }

      const snapshot = before.prepareSave();
      if (!snapshot) return;

      try {
        const result = await saveCallback(snapshot);
        store.getState().completeSave(snapshot, result.value, result.etag);
        if (onSaved) void Promise.resolve(onSaved(result, snapshot)).catch(() => undefined);
      } catch (error) {
        store.getState().failSave(snapshot, error);
      }

      const after = store.getState();
      if (after.saveStatus === "error" || after.saveStatus === "conflict") {
        pause();
        return;
      }

      if (!disposed && after.dirty && after.editVersion > snapshot.editVersion) {
        clearDebounce();
        flushRequested = true;
      }
    }
  };

  const requestFlush = (): Promise<void> => {
    if (disposed || paused) return Promise.resolve();
    clearDebounce();
    flushRequested = true;
    if (!drainPromise) {
      const running = drain();
      drainPromise = running.finally(() => {
        drainPromise = null;
      });
    }
    return drainPromise;
  };

  const unsubscribe = store.subscribe((state) => {
    if (disposed) return;
    if (state.saveStatus === "error" || state.saveStatus === "conflict") {
      observedEditVersion = state.editVersion;
      pause();
      return;
    }
    if (paused) {
      observedEditVersion = state.editVersion;
      if (!state.dirty && state.saveStatus === "clean") {
        paused = false;
      } else if (
        state.dirty
        && state.saveStatus === "dirty"
        && state.retrySaveSnapshot === null
      ) {
        paused = false;
        schedule();
      }
      return;
    }
    if (!state.dirty) {
      clearDebounce();
      observedEditVersion = state.editVersion;
      return;
    }
    if (state.editVersion === observedEditVersion) return;
    observedEditVersion = state.editVersion;
    schedule();
  });

  const onVisibilityChange = () => {
    if (visibilityTarget?.visibilityState === "hidden") void requestFlush();
  };
  const onPageHide = () => {
    void requestFlush();
  };
  visibilityTarget?.addEventListener("visibilitychange", onVisibilityChange);
  pageLifecycleTarget?.addEventListener("pagehide", onPageHide);

  if (store.getState().dirty) schedule();

  return {
    async dispose() {
      if (disposePromise) return disposePromise;
      disposing = true;
      clearDebounce();
      disposePromise = (async () => {
        while (!disposed) {
          if (paused && store.getState().saveStatus === "dirty") paused = false;
          await requestFlush();
          const state = store.getState();
          if (
            state.saveStatus === "error"
            || state.saveStatus === "conflict"
            || (!state.dirty && state.saveStatus === "clean")
          ) break;
        }

        disposed = true;
        flushRequested = false;
        clearDebounce();
        unsubscribe();
        visibilityTarget?.removeEventListener("visibilitychange", onVisibilityChange);
        pageLifecycleTarget?.removeEventListener("pagehide", onPageHide);
      })();
      return disposePromise;
    },
    flush: requestFlush,
    getState() {
      return {
        disposed,
        inFlight: drainPromise !== null,
        paused,
        pending: debounceTimer !== null || flushRequested,
      };
    },
    resume() {
      if (disposed) return false;
      const state = store.getState();
      if (state.saveStatus === "error" || state.saveStatus === "conflict") return false;
      paused = false;
      if (state.dirty) schedule();
      return true;
    },
    setSave(nextSave) {
      saveCallback = nextSave;
    },
  };
}

function defaultVisibilityTarget(): BoardAutosaveVisibilityTarget | null {
  if (typeof document === "undefined") return null;
  return {
    get visibilityState() {
      return document.visibilityState;
    },
    addEventListener(type, listener) {
      document.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      document.removeEventListener(type, listener);
    },
  };
}

function defaultPageLifecycleTarget(): BoardAutosaveEventTarget | null {
  if (typeof window === "undefined") return null;
  return {
    addEventListener(type, listener) {
      window.addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      window.removeEventListener(type, listener);
    },
  };
}
