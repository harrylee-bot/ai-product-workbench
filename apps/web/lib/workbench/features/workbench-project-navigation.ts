"use client";

import { useCallback, useEffect, useRef } from "react";

const WORKBENCH_BOARD_NODE_PARAM = "boardNode";
const WORKBENCH_HISTORY_STATE_KEY = "__workbenchNavigation";
const WORKBENCH_HISTORY_STATE_VERSION = 1;
const WORKBENCH_PROJECT_PATH_PREFIX = "/projects/";
export const WORKBENCH_URL_COMMITTED_EVENT = "workbench:navigation:url-committed";

export type WorkbenchCommittedUrlDetail = {
  href: string;
};

type WorkbenchHistoryState = {
  index: number;
  version: typeof WORKBENCH_HISTORY_STATE_VERSION;
};

type PendingWorkbenchHistoryTraversal = {
  committedHref: string;
  committedIndex: number;
  destinationHref: string;
  destinationIndex: number;
  phase: "guarding" | "replaying" | "restoring";
};

type WorkbenchNavigationLifecycle = {
  controller: AbortController;
  generation: number;
};

type WorkbenchNavigationTarget = Pick<
  Window,
  "addEventListener" | "dispatchEvent" | "history" | "location" | "removeEventListener"
>;

const committedHrefByTarget = new WeakMap<object, string>();

export type WorkbenchProjectNavigationOptions = {
  commitProjectOpen: (projectId: string) => void;
  enabled: boolean;
  navigateRoute: (href: string, signal?: AbortSignal) => Promise<void>;
  onClose: () => void;
  onError: (error: unknown) => void;
  onOpen: (projectId: string) => void;
  prepareProjectClose: (signal?: AbortSignal) => Promise<void>;
  prepareProjectOpen: (projectId: string, signal?: AbortSignal) => Promise<void>;
  prepareProjectRoute: (projectId: string, signal?: AbortSignal) => Promise<unknown>;
  selectedProjectId: string;
};

export function useWorkbenchProjectNavigation({
  commitProjectOpen,
  enabled,
  navigateRoute,
  onClose,
  onError,
  onOpen,
  prepareProjectClose,
  prepareProjectOpen,
  prepareProjectRoute,
  selectedProjectId,
}: WorkbenchProjectNavigationOptions) {
  const selectedProjectIdRef = useRef(selectedProjectId);
  const callbacksRef = useRef({
    commitProjectOpen,
    navigateRoute,
    onClose,
    onError,
    onOpen,
    prepareProjectClose,
    prepareProjectOpen,
    prepareProjectRoute,
  });
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const committedHrefRef = useRef(initialWorkbenchCommittedHref(selectedProjectId));
  const committedIndexRef = useRef(readWorkbenchHistoryIndex(window.history.state) ?? 0);
  const pendingHistoryRestoreRef = useRef<{ href: string; index: number } | null>(null);
  const pendingHistoryTraversalRef = useRef<PendingWorkbenchHistoryTraversal | null>(null);
  const lifecycleRef = useRef<WorkbenchNavigationLifecycle | null>(null);
  const lifecycleGenerationRef = useRef(0);

  selectedProjectIdRef.current = selectedProjectId;
  callbacksRef.current = {
    commitProjectOpen,
    navigateRoute,
    onClose,
    onError,
    onOpen,
    prepareProjectClose,
    prepareProjectOpen,
    prepareProjectRoute,
  };

  const enqueue = useCallback((
    destinationHref: string,
    source: "history" | "push",
    destinationIndex: number | null = null,
    lifecycle: WorkbenchNavigationLifecycle | null = lifecycleRef.current,
  ) => {
    let resolveResult!: (result: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      resolveResult = resolve;
    });

    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!isWorkbenchNavigationActive(lifecycleRef, lifecycle)) {
          resolveResult(false);
          return;
        }
        const currentProjectId = selectedProjectIdRef.current;
        const committedHref = committedHrefRef.current;
        const committedIndex = committedIndexRef.current;
        const destinationProjectId = readWorkbenchProjectId({ href: destinationHref });
        try {
          if (destinationProjectId) {
            await callbacksRef.current.prepareProjectRoute(
              destinationProjectId,
              lifecycle?.controller.signal,
            );
            if (!isWorkbenchNavigationActive(lifecycleRef, lifecycle)) {
              resolveResult(false);
              return;
            }
          }
          if (destinationProjectId !== currentProjectId) {
            if (destinationProjectId) {
              await callbacksRef.current.prepareProjectOpen(
                destinationProjectId,
                lifecycle?.controller.signal,
              );
            } else {
              await callbacksRef.current.prepareProjectClose(lifecycle?.controller.signal);
            }
            if (!isWorkbenchNavigationActive(lifecycleRef, lifecycle)) {
              resolveResult(false);
              return;
            }
          }

          if (source === "push") {
            if (sameWorkbenchHref(destinationHref, committedHref)) {
              if (destinationProjectId) {
                callbacksRef.current.commitProjectOpen(destinationProjectId);
                selectedProjectIdRef.current = destinationProjectId;
              }
              if (destinationProjectId) callbacksRef.current.onOpen(destinationProjectId);
              else callbacksRef.current.onClose();
              resolveResult(true);
              return;
            }
            const nextIndex = committedIndex + 1;
            const preservedHistoryState = window.history.state;
            await callbacksRef.current.navigateRoute(
              destinationHref,
              lifecycle?.controller.signal,
            );
            if (!isWorkbenchNavigationActive(lifecycleRef, lifecycle)) {
              resolveResult(false);
              return;
            }
            if (destinationProjectId) {
              callbacksRef.current.commitProjectOpen(destinationProjectId);
              selectedProjectIdRef.current = destinationProjectId;
            }
            committedHrefRef.current = commitWorkbenchRouterNavigation(
              destinationHref,
              nextIndex,
              preservedHistoryState,
            );
            committedIndexRef.current = nextIndex;
          }
          if (source === "history" && destinationProjectId) {
            callbacksRef.current.commitProjectOpen(destinationProjectId);
            selectedProjectIdRef.current = destinationProjectId;
          }
          if (destinationProjectId) callbacksRef.current.onOpen(destinationProjectId);
          else callbacksRef.current.onClose();
          if (source === "history") {
            committedHrefRef.current = publishWorkbenchCommittedHref(destinationHref);
            committedIndexRef.current = destinationIndex
              ?? readWorkbenchHistoryIndex(window.history.state)
              ?? committedIndex;
          }
          resolveResult(true);
        } catch (error) {
          if (!isWorkbenchNavigationActive(lifecycleRef, lifecycle)) {
            resolveResult(false);
            return;
          }
          if (source === "history") {
            const restoreDelta = destinationIndex === null
              ? 0
              : committedIndex - destinationIndex;
            if (restoreDelta !== 0) {
              pendingHistoryRestoreRef.current = {
                href: committedHref,
                index: committedIndex,
              };
              window.history.go(restoreDelta);
            } else {
              committedHrefRef.current = restoreWorkbenchCommittedHref(
                committedHref,
                committedIndex,
              );
            }
          }
          callbacksRef.current.onError(error);
          resolveResult(false);
        }
      });

    return result;
  }, []);

  const guardRestoredHistoryTraversal = useCallback((
    traversal: PendingWorkbenchHistoryTraversal,
    lifecycle: WorkbenchNavigationLifecycle,
  ) => {
    queueRef.current = queueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (
          !isWorkbenchNavigationActive(lifecycleRef, lifecycle)
          || pendingHistoryTraversalRef.current !== traversal
        ) {
          return;
        }
        const currentProjectId = selectedProjectIdRef.current;
        const destinationProjectId = readWorkbenchProjectId({ href: traversal.destinationHref });
        try {
          if (destinationProjectId) {
            await callbacksRef.current.prepareProjectRoute(
              destinationProjectId,
              lifecycle.controller.signal,
            );
            if (!isWorkbenchNavigationActive(lifecycleRef, lifecycle)) return;
          }
          if (destinationProjectId !== currentProjectId) {
            if (destinationProjectId) {
              await callbacksRef.current.prepareProjectOpen(
                destinationProjectId,
                lifecycle.controller.signal,
              );
            } else {
              await callbacksRef.current.prepareProjectClose(lifecycle.controller.signal);
            }
            if (!isWorkbenchNavigationActive(lifecycleRef, lifecycle)) return;
          }
          if (
            !isWorkbenchNavigationActive(lifecycleRef, lifecycle)
            || pendingHistoryTraversalRef.current !== traversal
          ) {
            return;
          }
          traversal.phase = "replaying";
          window.history.go(traversal.destinationIndex - traversal.committedIndex);
        } catch (error) {
          if (!isWorkbenchNavigationActive(lifecycleRef, lifecycle)) return;
          if (pendingHistoryTraversalRef.current === traversal) {
            pendingHistoryTraversalRef.current = null;
          }
          callbacksRef.current.onError(error);
        }
      });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const lifecycle = {
      controller: new AbortController(),
      generation: lifecycleGenerationRef.current + 1,
    };
    lifecycleGenerationRef.current = lifecycle.generation;
    lifecycleRef.current = lifecycle;
    const currentIndex = ensureWorkbenchHistoryIndex(window);
    const publishedHref = committedHrefByTarget.get(window);
    if (
      publishedHref === window.location.href
      && readWorkbenchProjectId({ href: publishedHref }) === selectedProjectIdRef.current
    ) {
      committedHrefRef.current = publishedHref;
    }
    const unsubscribe = subscribeWorkbenchCommittedUrl((href) => {
      committedHrefRef.current = href;
      committedIndexRef.current = readWorkbenchHistoryIndex(window.history.state)
        ?? committedIndexRef.current;
    });
    void enqueue(window.location.href, "history", currentIndex, lifecycle);

    const onPopState = () => {
      const href = window.location.href;
      const index = readWorkbenchHistoryIndex(window.history.state);
      const pendingTraversal = pendingHistoryTraversalRef.current;
      if (pendingTraversal) {
        if (
          pendingTraversal.phase === "restoring"
          && href === pendingTraversal.committedHref
          && index === pendingTraversal.committedIndex
        ) {
          pendingTraversal.phase = "guarding";
          guardRestoredHistoryTraversal(pendingTraversal, lifecycle);
          return;
        }
        if (
          pendingTraversal.phase === "replaying"
          && href === pendingTraversal.destinationHref
          && index === pendingTraversal.destinationIndex
        ) {
          pendingHistoryTraversalRef.current = null;
          const destinationProjectId = readWorkbenchProjectId({ href });
          if (destinationProjectId) {
            callbacksRef.current.commitProjectOpen(destinationProjectId);
            selectedProjectIdRef.current = destinationProjectId;
          }
          if (destinationProjectId) callbacksRef.current.onOpen(destinationProjectId);
          else callbacksRef.current.onClose();
          committedHrefRef.current = publishWorkbenchCommittedHref(href);
          committedIndexRef.current = pendingTraversal.destinationIndex;
          return;
        }
        if (index !== pendingTraversal.committedIndex || href !== pendingTraversal.committedHref) {
          if (pendingTraversal.phase === "replaying") {
            pendingTraversal.phase = "restoring";
          }
          const restoredImmediately = restorePendingWorkbenchTraversal(pendingTraversal, index);
          if (restoredImmediately && pendingTraversal.phase === "restoring") {
            pendingTraversal.phase = "guarding";
            guardRestoredHistoryTraversal(pendingTraversal, lifecycle);
          }
        }
        return;
      }
      const pendingRestore = pendingHistoryRestoreRef.current;
      if (
        pendingRestore
        && href === pendingRestore.href
        && index === pendingRestore.index
      ) {
        pendingHistoryRestoreRef.current = null;
        committedHrefRef.current = publishWorkbenchCommittedHref(href);
        committedIndexRef.current = index;
        return;
      }
      if (index !== null && index !== committedIndexRef.current) {
        const traversal: PendingWorkbenchHistoryTraversal = {
          committedHref: committedHrefRef.current,
          committedIndex: committedIndexRef.current,
          destinationHref: href,
          destinationIndex: index,
          phase: "restoring",
        };
        pendingHistoryTraversalRef.current = traversal;
        window.history.go(traversal.committedIndex - traversal.destinationIndex);
        return;
      }
      void enqueue(href, "history", index, lifecycle);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      lifecycle.controller.abort();
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      lifecycleGenerationRef.current += 1;
      pendingHistoryRestoreRef.current = null;
      pendingHistoryTraversalRef.current = null;
      queueRef.current = Promise.resolve();
      unsubscribe();
      window.removeEventListener("popstate", onPopState);
    };
  }, [enabled, enqueue, guardRestoredHistoryTraversal]);

  const commitOpenedProject = useCallback(async (projectId: string) => {
    const committed = await enqueue(createWorkbenchProjectHref(projectId), "push");
    if (committed) return true;
    selectedProjectIdRef.current = readWorkbenchProjectId({ href: committedHrefRef.current });
    return false;
  }, [enqueue]);

  return {
    closeProject: () => enqueue(createWorkbenchProjectHref(""), "push"),
    commitOpenedProject,
    openProject: (projectId: string) => enqueue(createWorkbenchProjectHref(projectId), "push"),
  };
}

export function subscribeWorkbenchCommittedUrl(
  listener: (href: string) => void,
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const handleCommittedUrl = (event: Event) => {
    const detail = (event as CustomEvent<WorkbenchCommittedUrlDetail>).detail;
    if (detail && typeof detail.href === "string") listener(detail.href);
  };
  target.addEventListener(WORKBENCH_URL_COMMITTED_EVENT, handleCommittedUrl);
  return () => target.removeEventListener(WORKBENCH_URL_COMMITTED_EVENT, handleCommittedUrl);
}

export function readWorkbenchProjectId(location: Pick<Location, "href"> = window.location): string {
  const pathname = new URL(location.href).pathname;
  if (!pathname.startsWith(WORKBENCH_PROJECT_PATH_PREFIX)) return "";
  const encodedProjectId = pathname.slice(WORKBENCH_PROJECT_PATH_PREFIX.length);
  if (!encodedProjectId || encodedProjectId.includes("/")) return "";
  try {
    return decodeURIComponent(encodedProjectId).trim();
  } catch {
    return "";
  }
}

export function readWorkbenchBoardNodeId(location: Pick<Location, "href"> = window.location): string {
  return new URL(location.href).searchParams.get(WORKBENCH_BOARD_NODE_PARAM)?.trim() ?? "";
}

export function createWorkbenchBoardNodeUrl(
  projectId: string,
  nodeId: string,
  location: Pick<Location, "href"> = window.location,
): string {
  const url = new URL(location.href);
  url.pathname = createWorkbenchProjectPath(projectId);
  url.searchParams.set(WORKBENCH_BOARD_NODE_PARAM, nodeId);
  return url.href;
}

export function writeWorkbenchBoardNodeUrl(
  projectId: string,
  nodeId: string,
  mode: "push" | "replace" = "replace",
  target: Pick<Window, "dispatchEvent" | "history" | "location"> = window,
): void {
  if (!projectId) return;
  const url = new URL(target.location.href);
  url.pathname = createWorkbenchProjectPath(projectId);
  if (nodeId) url.searchParams.set(WORKBENCH_BOARD_NODE_PARAM, nodeId);
  else url.searchParams.delete(WORKBENCH_BOARD_NODE_PARAM);
  writeWorkbenchUrl(url, mode, target);
}

function writeWorkbenchUrl(
  url: URL,
  mode: "push" | "replace",
  target: Pick<Window, "dispatchEvent" | "history" | "location">,
): void {
  const currentIndex = readWorkbenchHistoryIndex(target.history.state) ?? 0;
  const nextIndex = mode === "push" ? currentIndex + 1 : currentIndex;
  target.history[mode === "push" ? "pushState" : "replaceState"](
    mergeWorkbenchHistoryState(target.history.state, nextIndex),
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  publishWorkbenchCommittedHref(target.location.href, target);
}

function commitWorkbenchRouterNavigation(
  href: string,
  index: number,
  preservedState: unknown,
  target: WorkbenchNavigationTarget = window,
): string {
  const current = new URL(target.location.href);
  const destination = new URL(href, current);
  if (destination.origin !== current.origin) {
    throw new Error("Cannot commit a Workbench route from another origin");
  }
  const preserved = preservedState && typeof preservedState === "object"
    ? preservedState as Record<string, unknown>
    : {};
  const currentState = target.history.state && typeof target.history.state === "object"
    ? target.history.state as Record<string, unknown>
    : {};
  target.history.replaceState(
    mergeWorkbenchHistoryState({ ...preserved, ...currentState }, index),
    "",
    `${destination.pathname}${destination.search}${destination.hash}`,
  );
  return publishWorkbenchCommittedHref(target.location.href, target);
}

export function createWorkbenchProjectPath(projectId: string): string {
  return `${WORKBENCH_PROJECT_PATH_PREFIX}${encodeURIComponent(projectId)}`;
}

function createWorkbenchProjectHref(projectId: string): string {
  const current = new URL(window.location.href);
  if (projectId && readWorkbenchProjectId({ href: current.href }) === projectId) {
    return current.href;
  }
  return new URL(projectId ? createWorkbenchProjectPath(projectId) : "/", current.origin).href;
}

function initialWorkbenchCommittedHref(selectedProjectId: string): string {
  const url = new URL(window.location.href);
  if (readWorkbenchProjectId({ href: url.href }) === selectedProjectId) return url.href;
  url.pathname = selectedProjectId ? createWorkbenchProjectPath(selectedProjectId) : "/";
  url.searchParams.delete(WORKBENCH_BOARD_NODE_PARAM);
  return url.href;
}

function restoreWorkbenchCommittedHref(
  href: string,
  index: number,
  target: WorkbenchNavigationTarget = window,
): string {
  const current = new URL(target.location.href);
  const committed = new URL(href, current);
  if (committed.origin !== current.origin) {
    throw new Error("Cannot restore a Workbench URL from another origin");
  }
  target.history.replaceState(
    mergeWorkbenchHistoryState(target.history.state, index),
    "",
    `${committed.pathname}${committed.search}${committed.hash}`,
  );
  return publishWorkbenchCommittedHref(target.location.href, target);
}

function ensureWorkbenchHistoryIndex(target: WorkbenchNavigationTarget): number {
  const existingIndex = readWorkbenchHistoryIndex(target.history.state);
  if (existingIndex !== null) return existingIndex;
  const index = 0;
  const current = new URL(target.location.href);
  target.history.replaceState(
    mergeWorkbenchHistoryState(target.history.state, index),
    "",
    `${current.pathname}${current.search}${current.hash}`,
  );
  return index;
}

function readWorkbenchHistoryIndex(state: unknown): number | null {
  if (!state || typeof state !== "object") return null;
  const metadata = (state as Record<string, unknown>)[WORKBENCH_HISTORY_STATE_KEY];
  if (!metadata || typeof metadata !== "object") return null;
  const candidate = metadata as Partial<WorkbenchHistoryState>;
  if (
    candidate.version !== WORKBENCH_HISTORY_STATE_VERSION
    || !Number.isSafeInteger(candidate.index)
  ) {
    return null;
  }
  return candidate.index ?? null;
}

function mergeWorkbenchHistoryState(state: unknown, index: number): Record<string, unknown> {
  const current = state && typeof state === "object"
    ? state as Record<string, unknown>
    : {};
  return {
    ...current,
    [WORKBENCH_HISTORY_STATE_KEY]: {
      index,
      version: WORKBENCH_HISTORY_STATE_VERSION,
    } satisfies WorkbenchHistoryState,
  };
}

function publishWorkbenchCommittedHref(
  href: string,
  target: Pick<Window, "dispatchEvent" | "location"> = window,
): string {
  const normalizedHref = new URL(href, target.location.href).href;
  committedHrefByTarget.set(target, normalizedHref);
  target.dispatchEvent(new CustomEvent<WorkbenchCommittedUrlDetail>(
    WORKBENCH_URL_COMMITTED_EVENT,
    { detail: { href: normalizedHref } },
  ));
  return normalizedHref;
}

function isWorkbenchNavigationActive(
  lifecycleRef: { current: WorkbenchNavigationLifecycle | null },
  lifecycle: WorkbenchNavigationLifecycle | null,
): lifecycle is WorkbenchNavigationLifecycle {
  return Boolean(
    lifecycle
    && lifecycleRef.current === lifecycle
    && !lifecycle.controller.signal.aborted,
  );
}

function restorePendingWorkbenchTraversal(
  traversal: PendingWorkbenchHistoryTraversal,
  currentIndex: number | null,
): boolean {
  if (currentIndex === traversal.committedIndex) {
    restoreWorkbenchCommittedHref(traversal.committedHref, traversal.committedIndex);
    return true;
  }
  const restoreDelta = currentIndex === null
    ? Math.sign(traversal.committedIndex - traversal.destinationIndex)
    : traversal.committedIndex - currentIndex;
  if (restoreDelta !== 0) window.history.go(restoreDelta);
  return false;
}

function sameWorkbenchHref(left: string, right: string): boolean {
  return new URL(left, window.location.href).href === new URL(right, window.location.href).href;
}
