// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWorkbenchBoardNodeUrl,
  readWorkbenchBoardNodeId,
  readWorkbenchProjectId,
  subscribeWorkbenchCommittedUrl,
  useWorkbenchProjectNavigation,
  writeWorkbenchBoardNodeUrl,
} from "./workbench-project-navigation";

describe("Workbench Project URL navigation", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("restores a deep-linked Project without deleting the query or unrelated URL state", async () => {
    window.history.replaceState({}, "", "/projects/project-1?source=refresh#canvas");
    const onOpen = vi.fn();
    const rendered = renderNavigation({ onOpen });

    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe("project-1"));
    expect(onOpen).toHaveBeenCalledWith("project-1");
    expect(window.location.search).toBe("?source=refresh");
    expect(window.location.hash).toBe("#canvas");
    rendered.unmount();
  });

  it("pushes Project state and follows browser back and forward", async () => {
    const rendered = renderNavigation();
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe(""));

    await act(() => rendered.result.current.openProject("project-1"));
    expect(readWorkbenchProjectId()).toBe("project-1");
    expect(rendered.result.current.selectedProjectId).toBe("project-1");

    act(() => {
      window.history.replaceState(window.history.state, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    await waitFor(() => expect(readWorkbenchProjectId()).toBe(""));
    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    act(() => rendered.result.current.finalizeProjectClose());
    expect(rendered.result.current.selectedProjectId).toBe("");
    expect(readWorkbenchProjectId()).toBe("");

    act(() => {
      window.history.replaceState(window.history.state, "", "/projects/project-1");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe("project-1"));
    expect(readWorkbenchProjectId()).toBe("project-1");
    rendered.unmount();
  });

  it("returns to the committed entry before awaiting an indexed browser save barrier", async () => {
    let releaseClose!: () => void;
    const closeBarrier = vi.fn(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));
    const onClose = vi.fn();
    const rendered = renderNavigation({ closeBarrier, onClose });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe(""));
    window.history.replaceState(
      { ...window.history.state, marker: "home" },
      "",
      "/?target=home#home",
    );
    const homeHref = window.location.href;
    const homeState = structuredClone(window.history.state);

    await act(() => rendered.result.current.openProject("project-1"));
    window.history.replaceState(
      { ...window.history.state, marker: "project" },
      "",
      "/projects/project-1#canvas",
    );
    writeWorkbenchBoardNodeUrl("project-1", "node-1");
    const projectHref = window.location.href;
    const projectState = structuredClone(window.history.state);
    const committedUrls: string[] = [];
    const unsubscribe = subscribeWorkbenchCommittedUrl((href) => committedUrls.push(href));
    onClose.mockClear();
    const go = vi.spyOn(window.history, "go").mockImplementation((delta?: number) => {
      queueMicrotask(() => {
        if (delta === 1) {
          window.history.replaceState(projectState, "", projectHref);
          window.dispatchEvent(new PopStateEvent("popstate", { state: projectState }));
        } else if (delta === -1) {
          window.history.replaceState(homeState, "", homeHref);
          window.dispatchEvent(new PopStateEvent("popstate", { state: homeState }));
        }
      });
    });

    act(() => {
      window.history.replaceState(homeState, "", homeHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: homeState }));
    });

    expect(go).toHaveBeenCalledWith(1);
    await waitFor(() => expect(closeBarrier).toHaveBeenCalledOnce());
    expect(window.location.href).toBe(projectHref);
    expect(window.history.state).toEqual(expect.objectContaining({ marker: "project" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(committedUrls).toEqual([]);

    releaseClose();

    await waitFor(() => expect(go).toHaveBeenLastCalledWith(-1));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(window.location.href).toBe(homeHref);
    expect(window.history.state).toEqual(expect.objectContaining({ marker: "home" }));
    expect(committedUrls).toEqual([homeHref]);
    unsubscribe();
    rendered.unmount();
  });

  it("recovers mixed indexed and unindexed rapid pops without leaving replay stuck", async () => {
    let releaseClose!: () => void;
    const closeBarrier = vi.fn(() => {
      if (closeBarrier.mock.calls.length > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
    });
    const onClose = vi.fn();
    const rendered = renderNavigation({ closeBarrier, onClose });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe(""));
    window.history.replaceState(
      { ...window.history.state, marker: "home" },
      "",
      "/?target=home#home",
    );
    const homeHref = window.location.href;
    const homeState = structuredClone(window.history.state);

    await act(() => rendered.result.current.openProject("project-1"));
    window.history.replaceState(
      { ...window.history.state, marker: "project" },
      "",
      "/projects/project-1?old=1#canvas",
    );
    writeWorkbenchBoardNodeUrl("project-1", "node-1");
    const projectHref = window.location.href;
    const projectState = structuredClone(window.history.state);
    const olderIndexedState = structuredClone(homeState) as {
      __workbenchNavigation: { index: number };
      marker: string;
    };
    olderIndexedState.__workbenchNavigation.index = -1;
    olderIndexedState.marker = "older-indexed";
    const committedUrls: string[] = [];
    const unsubscribe = subscribeWorkbenchCommittedUrl((href) => committedUrls.push(href));
    committedUrls.length = 0;
    onClose.mockClear();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);

    act(() => {
      window.history.replaceState(homeState, "", homeHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: homeState }));
    });
    expect(go).toHaveBeenLastCalledWith(1);

    act(() => {
      window.history.replaceState(projectState, "", projectHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: projectState }));
    });
    await waitFor(() => expect(closeBarrier).toHaveBeenCalledOnce());
    releaseClose();
    await waitFor(() => expect(go).toHaveBeenLastCalledWith(-1));

    act(() => {
      window.history.replaceState({ marker: "unindexed" }, "", "/outside?rapid=1#first");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    expect(go).toHaveBeenLastCalledWith(1);

    act(() => {
      window.history.replaceState(olderIndexedState, "", "/outside?rapid=2#second");
      window.dispatchEvent(new PopStateEvent("popstate", { state: olderIndexedState }));
    });
    expect(go).toHaveBeenLastCalledWith(2);

    act(() => {
      window.history.replaceState(projectState, "", projectHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: projectState }));
    });
    await waitFor(() => expect(go).toHaveBeenLastCalledWith(-1));

    act(() => {
      window.history.replaceState(homeState, "", homeHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: homeState }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(committedUrls).toEqual([homeHref]);
    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    act(() => rendered.result.current.finalizeProjectClose());
    expect(rendered.result.current.selectedProjectId).toBe("");

    act(() => {
      window.history.replaceState(projectState, "", projectHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: projectState }));
    });
    expect(go).toHaveBeenLastCalledWith(-1);
    expect(go).toHaveBeenCalledTimes(6);

    unsubscribe();
    rendered.unmount();
  });

  it("invalidates an in-flight history guard when its owner unmounts", async () => {
    let releaseClose!: () => void;
    let closeSignal: AbortSignal | undefined;
    const prepareProjectClose = vi.fn((signal?: AbortSignal) => new Promise<void>((resolve) => {
      closeSignal = signal;
      releaseClose = resolve;
    }));
    const onClose = vi.fn();
    const onError = vi.fn();
    const rendered = renderNavigation({ prepareProjectClose, onClose, onError });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe(""));
    const homeHref = window.location.href;
    const homeState = structuredClone(window.history.state);
    await act(() => rendered.result.current.openProject("project-1"));
    const projectHref = window.location.href;
    const projectState = structuredClone(window.history.state);
    const committedUrls: string[] = [];
    const unsubscribe = subscribeWorkbenchCommittedUrl((href) => committedUrls.push(href));
    onClose.mockClear();
    const go = vi.spyOn(window.history, "go").mockImplementation((delta?: number) => {
      if (delta !== 1) return;
      queueMicrotask(() => {
        window.history.replaceState(projectState, "", projectHref);
        window.dispatchEvent(new PopStateEvent("popstate", { state: projectState }));
      });
    });

    act(() => {
      window.history.replaceState(homeState, "", homeHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: homeState }));
    });
    await waitFor(() => expect(prepareProjectClose).toHaveBeenCalledOnce());
    expect(go).toHaveBeenCalledOnce();
    expect(closeSignal?.aborted).toBe(false);

    rendered.unmount();
    expect(closeSignal?.aborted).toBe(true);
    releaseClose();
    await Promise.resolve();
    await Promise.resolve();

    expect(go).toHaveBeenCalledOnce();
    expect(committedUrls).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(window.location.href).toBe(projectHref);
    unsubscribe();
  });

  it("keeps Home committed until the Project route preload resolves", async () => {
    let resolveProjectRoute!: () => void;
    const prepareProjectRoute = vi.fn(() => new Promise<void>((resolve) => {
      resolveProjectRoute = resolve;
    }));
    const navigateRoute = vi.fn(async (href: string) => {
      window.history.pushState(window.history.state, "", href);
    });
    const rendered = renderNavigation({ navigateRoute, prepareProjectRoute });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe(""));

    let transition!: Promise<boolean>;
    act(() => {
      transition = rendered.result.current.openProject("project-1");
    });
    await waitFor(() => expect(prepareProjectRoute).toHaveBeenCalledOnce());

    expect(rendered.result.current.selectedProjectId).toBe("");
    expect(navigateRoute).not.toHaveBeenCalled();

    resolveProjectRoute();
    await act(() => transition);

    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    expect(navigateRoute).toHaveBeenCalledOnce();
    rendered.unmount();
  });

  it("does not commit or publish the Project owner before the exact route acknowledgement", async () => {
    let acknowledgeRoute!: () => void;
    const routeAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeRoute = resolve;
    });
    const commitProjectOpen = vi.fn();
    const navigateRoute = vi.fn((href: string) => {
      window.history.pushState(window.history.state, "", href);
      return routeAcknowledgement;
    });
    const committedUrls: string[] = [];
    const unsubscribe = subscribeWorkbenchCommittedUrl((href) => committedUrls.push(href));
    const rendered = renderNavigation({ commitProjectOpen, navigateRoute });
    await act(async () => undefined);
    committedUrls.length = 0;

    let transition!: Promise<boolean>;
    act(() => {
      transition = rendered.result.current.openProject("project-1");
    });
    await waitFor(() => expect(navigateRoute).toHaveBeenCalledOnce());

    expect(window.location.pathname).toBe("/projects/project-1");
    expect(rendered.result.current.selectedProjectId).toBe("");
    expect(commitProjectOpen).not.toHaveBeenCalled();
    expect(committedUrls).toEqual([]);

    acknowledgeRoute();
    await act(() => transition);

    expect(commitProjectOpen).toHaveBeenCalledWith("project-1");
    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    expect(committedUrls).toEqual(["http://localhost:3000/projects/project-1"]);
    unsubscribe();
    rendered.unmount();
  });

  it("commits a Project owner only after an indexed history replay reaches its target", async () => {
    let blockProjectPreparation = false;
    let releaseProjectPreparation!: () => void;
    const prepareProjectOpen = vi.fn(() => {
      if (!blockProjectPreparation) return Promise.resolve();
      return new Promise<void>((resolve) => {
        releaseProjectPreparation = resolve;
      });
    });
    const commitProjectOpen = vi.fn();
    const onOpen = vi.fn();
    const rendered = renderNavigation({ commitProjectOpen, onOpen, prepareProjectOpen });
    await act(() => rendered.result.current.openProject("project-1"));
    const projectHref = window.location.href;
    const projectState = structuredClone(window.history.state);
    await act(() => rendered.result.current.closeProject());
    const homeHref = window.location.href;
    const homeState = structuredClone(window.history.state);
    act(() => rendered.result.current.finalizeProjectClose());
    expect(rendered.result.current.selectedProjectId).toBe("");

    blockProjectPreparation = true;
    commitProjectOpen.mockClear();
    onOpen.mockClear();
    const go = vi.spyOn(window.history, "go").mockImplementation((delta?: number) => {
      queueMicrotask(() => {
        if (delta === 1) {
          window.history.replaceState(homeState, "", homeHref);
          window.dispatchEvent(new PopStateEvent("popstate", { state: homeState }));
        } else if (delta === -1) {
          window.history.replaceState(projectState, "", projectHref);
          window.dispatchEvent(new PopStateEvent("popstate", { state: projectState }));
        }
      });
    });

    act(() => {
      window.history.replaceState(projectState, "", projectHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: projectState }));
    });
    expect(go).toHaveBeenCalledWith(1);
    await waitFor(() => expect(prepareProjectOpen).toHaveBeenCalledTimes(2));

    expect(window.location.href).toBe(homeHref);
    expect(rendered.result.current.selectedProjectId).toBe("");
    expect(commitProjectOpen).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();

    releaseProjectPreparation();
    await waitFor(() => expect(go).toHaveBeenLastCalledWith(-1));
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe("project-1"));

    expect(commitProjectOpen).toHaveBeenCalledWith("project-1");
    expect(onOpen).toHaveBeenCalledWith("project-1");
    expect(window.location.href).toBe(projectHref);
    rendered.unmount();
  });

  it("keeps the Home data owner untouched when the Next route commit fails", async () => {
    const routeError = new Error("route failed");
    const commitProjectOpen = vi.fn();
    const onError = vi.fn();
    const rendered = renderNavigation({
      commitProjectOpen,
      navigateRoute: vi.fn(async () => {
        throw routeError;
      }),
      onError,
    });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe(""));

    await expect(act(() => rendered.result.current.openProject("project-1")))
      .resolves.toBe(false);

    expect(rendered.result.current.selectedProjectId).toBe("");
    expect(window.location.pathname).toBe("/");
    expect(commitProjectOpen).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(routeError);
    rendered.unmount();
  });

  it("restores the current URL when a browser navigation fails its save barrier", async () => {
    const prepareProjectClose = vi.fn(async () => {
      throw new Error("save failed");
    });
    const onError = vi.fn();
    const rendered = renderNavigation({ prepareProjectClose, onError });
    await act(() => rendered.result.current.openProject("project-1"));

    act(() => {
      window.history.replaceState(window.history.state, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    expect(readWorkbenchProjectId()).toBe("project-1");
    rendered.unmount();
  });

  it("restores the complete committed Project URL when a browser navigation fails its save barrier", async () => {
    const committedHref = "/projects/project-1?old=1&boardNode=node-1#canvas";
    window.history.replaceState({ marker: "committed" }, "", committedHref);
    const prepareProjectClose = vi.fn(async () => {
      throw new Error("save failed");
    });
    const onError = vi.fn();
    const rendered = renderNavigation({ prepareProjectClose, onError });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe("project-1"));

    act(() => {
      window.history.replaceState({ marker: "target" }, "", "/?new=1#home");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(window.location.href).toBe(`http://localhost:3000${committedHref}`);
    expect(readWorkbenchBoardNodeId()).toBe("node-1");
    expect(window.history.state).toEqual(expect.objectContaining({ marker: "target" }));
    rendered.unmount();
  });

  it("returns to the indexed committed entry without overwriting the failed history target", async () => {
    const targetHref = "/?new=1#home";
    const committedHref = "/projects/project-1?old=1&boardNode=node-1#canvas";
    window.history.replaceState({ marker: "target" }, "", targetHref);
    const prepareProjectClose = vi.fn(async () => {
      throw new Error("save failed");
    });
    const onError = vi.fn();
    const rendered = renderNavigation({ prepareProjectClose, onError });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe(""));

    const targetState = structuredClone(window.history.state);
    await act(() => rendered.result.current.openProject("project-1"));
    window.history.replaceState(
      { ...window.history.state, marker: "committed" },
      "",
      "/projects/project-1?old=1#canvas",
    );
    writeWorkbenchBoardNodeUrl("project-1", "node-1");
    expect(window.location.href).toBe(`http://localhost:3000${committedHref}`);
    const committedState = structuredClone(window.history.state);
    let stateAtRestoreRequest: unknown;
    let hrefAtRestoreRequest = "";
    const go = vi.spyOn(window.history, "go").mockImplementation((delta?: number) => {
      expect(delta).toBe(1);
      stateAtRestoreRequest = structuredClone(window.history.state);
      hrefAtRestoreRequest = window.location.href;
      window.history.replaceState(committedState, "", committedHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: committedState }));
    });

    act(() => {
      window.history.replaceState(targetState, "", targetHref);
      window.dispatchEvent(new PopStateEvent("popstate", { state: targetState }));
    });
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());

    expect(go).toHaveBeenCalledOnce();
    expect(hrefAtRestoreRequest).toBe("http://localhost:3000/?new=1#home");
    expect(stateAtRestoreRequest).toEqual(expect.objectContaining({ marker: "target" }));
    expect(window.location.href).toBe(`http://localhost:3000${committedHref}`);
    expect(window.history.state).toEqual(expect.objectContaining({ marker: "committed" }));
    expect(prepareProjectClose).toHaveBeenCalledOnce();
    expect(rendered.result.current.selectedProjectId).toBe("project-1");
    rendered.unmount();
  });

  it("accepts the complete target URL after a successful browser navigation", async () => {
    window.history.replaceState(
      { marker: "committed" },
      "",
      "/projects/project-1?old=1&boardNode=node-1#canvas",
    );
    const committedUrls: string[] = [];
    const unsubscribe = subscribeWorkbenchCommittedUrl((href) => committedUrls.push(href));
    const onClose = vi.fn();
    const rendered = renderNavigation({ onClose });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe("project-1"));

    act(() => {
      window.history.replaceState({ marker: "target" }, "", "/?new=1#home");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(rendered.result.current.selectedProjectId).toBe("project-1");

    expect(onClose).toHaveBeenCalledOnce();
    expect(window.location.href).toBe("http://localhost:3000/?new=1#home");
    expect(window.history.state).toEqual(expect.objectContaining({ marker: "target" }));
    expect(committedUrls.at(-1)).toBe("http://localhost:3000/?new=1#home");
    act(() => rendered.result.current.finalizeProjectClose());
    expect(rendered.result.current.selectedProjectId).toBe("");
    unsubscribe();
    rendered.unmount();
  });

  it("opens another Project at its canonical URL and preserves custom history state", async () => {
    window.history.replaceState({ marker: true }, "", "/projects/project-1?filter=owned&boardNode=node-1#projects");
    const navigateRoute = vi.fn(async (href: string) => {
      window.history.pushState(window.history.state, "", href);
    });
    const rendered = renderNavigation({ navigateRoute });
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe("project-1"));

    await act(() => rendered.result.current.openProject("project-2"));

    expect(navigateRoute).toHaveBeenCalledWith(
      "http://localhost:3000/projects/project-2",
      expect.any(AbortSignal),
    );
    expect(window.location.href).toBe("http://localhost:3000/projects/project-2");
    expect(readWorkbenchBoardNodeId()).toBe("");
    expect(window.history.state).toEqual(expect.objectContaining({ marker: true }));
    rendered.unmount();
  });

  it("creates and restores a Project-scoped Board node deep link", () => {
    window.history.replaceState({ marker: true }, "", "/projects/project-1?filter=owned#canvas");

    expect(createWorkbenchBoardNodeUrl("project-1", "node/one"))
      .toBe("http://localhost:3000/projects/project-1?filter=owned&boardNode=node%2Fone#canvas");
    writeWorkbenchBoardNodeUrl("project-1", "node/one", "replace");
    expect(readWorkbenchProjectId()).toBe("project-1");
    expect(readWorkbenchBoardNodeId()).toBe("node/one");
    expect(window.history.state).toEqual(expect.objectContaining({ marker: true }));

    writeWorkbenchBoardNodeUrl("project-1", "", "replace");
    expect(readWorkbenchBoardNodeId()).toBe("");
    expect(window.location.search).toBe("?filter=owned");
    expect(window.location.hash).toBe("#canvas");
  });

  it("does not synthesize a /projects/ URL while the exiting Project has no id", () => {
    window.history.replaceState({ marker: true }, "", "/?new=1#home");

    writeWorkbenchBoardNodeUrl("", "");

    expect(window.location.href).toBe("http://localhost:3000/?new=1#home");
    expect(window.history.state).toEqual({ marker: true });
  });

  it("publishes every successful Project route and Board URL write", async () => {
    const committedUrls: string[] = [];
    const unsubscribe = subscribeWorkbenchCommittedUrl((href) => committedUrls.push(href));
    const rendered = renderNavigation();
    await waitFor(() => expect(rendered.result.current.selectedProjectId).toBe(""));
    committedUrls.length = 0;

    await act(() => rendered.result.current.openProject("project-1"));
    writeWorkbenchBoardNodeUrl("project-1", "node-1", "replace");

    expect(committedUrls).toEqual([
      "http://localhost:3000/projects/project-1",
      "http://localhost:3000/projects/project-1?boardNode=node-1",
    ]);
    unsubscribe();
    rendered.unmount();
  });
});

function renderNavigation({
  closeBarrier,
  commitProjectOpen: commitProjectOpenOverride,
  navigateRoute = async (href: string) => {
    window.history.pushState(window.history.state, "", href);
  },
  onError = vi.fn(),
  onClose = vi.fn(),
  onOpen = vi.fn(),
  prepareProjectClose: prepareProjectCloseOverride,
  prepareProjectOpen = async () => undefined,
  prepareProjectRoute = async () => undefined,
}: {
  closeBarrier?: () => Promise<void>;
  commitProjectOpen?: (projectId: string) => void;
  navigateRoute?: (href: string) => Promise<void>;
  onError?: (error: unknown) => void;
  onClose?: () => void;
  onOpen?: (projectId: string) => void;
  prepareProjectClose?: (signal?: AbortSignal) => Promise<void>;
  prepareProjectOpen?: (projectId: string, signal?: AbortSignal) => Promise<void>;
  prepareProjectRoute?: (projectId: string) => Promise<unknown>;
} = {}) {
  return renderHook(() => {
    const [selectedProjectId, setSelectedProjectId] = useState("");
    const navigation = useWorkbenchProjectNavigation({
      commitProjectOpen: (projectId) => {
        commitProjectOpenOverride?.(projectId);
        setSelectedProjectId(projectId);
      },
      prepareProjectClose: prepareProjectCloseOverride ?? (async (signal) => {
        await closeBarrier?.();
        if (signal?.aborted) return;
      }),
      enabled: true,
      navigateRoute,
      onClose,
      onError,
      onOpen,
      prepareProjectOpen,
      prepareProjectRoute,
      selectedProjectId,
    });
    return {
      ...navigation,
      finalizeProjectClose: () => setSelectedProjectId(""),
      selectedProjectId,
    };
  });
}
