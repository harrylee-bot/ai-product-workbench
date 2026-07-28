"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import {
  useWorkbenchController,
} from "@/lib/workbench/features/workbench-controller";
import {
  createWorkbenchProjectPath,
  readWorkbenchProjectId,
  subscribeWorkbenchCommittedUrl,
  useWorkbenchProjectNavigation,
} from "@/lib/workbench/features/workbench-project-navigation";

import { WorkbenchUploadList } from "./workbench-upload-list";
import {
  currentWorkbenchRouteHref,
  normalizeWorkbenchRouteHref,
  workbenchRouteIsCommitted,
} from "./workbench-next-route-port";
import {
  preloadWorkbenchProjectRoute,
} from "./workbench-project-route-loader";
import { WorkbenchScene } from "./workbench-scene";
import {
  type WorkbenchRouteView,
  type WorkbenchRuntimeContextValue,
} from "./workbench-runtime-context";
import type { CanvasInteractionMode, CanvasPanel } from "@/lib/workbench/canvas-tools";

type PendingWorkbenchRouteChange = {
  abortListener: (() => void) | null;
  frame: number;
  href: string;
  reject: (error: Error) => void;
  resolve: () => void;
  signal: AbortSignal | null;
  timeout: number;
};

const WORKBENCH_SUBMISSION_ERROR_TOAST_ID = "workbench-submission-error";

export function WorkbenchRuntimeProvider() {
  const router = useRouter();
  const pathname = usePathname();
  const routeSearch = useSearchParams().toString();
  const pathnameView = workbenchRouteView(pathname);
  const [committedView, setCommittedView] = useState<WorkbenchRouteView>(pathnameView);
  const { logout, user } = useWorkbenchAuth();
  const [homeProjectTab, setHomeProjectTab] = useState<"mine" | "shared">("mine");
  const [projectSearch, setProjectSearch] = useState("");
  const deferredProjectSearch = useDeferredValue(projectSearch.trim());
  const workbench = useWorkbenchController({
    projectQuery: deferredProjectSearch,
    projectRelationship: homeProjectTab === "mine" ? "owned" : "shared",
  });
  const [homePrompt, setHomePrompt] = useState("");
  const [persistedPrompt, setPersistedPrompt] = useState("");
  const [projectDraft, setProjectDraft] = useState("");
  const [activeTool, setActiveTool] = useState<CanvasInteractionMode>("select");
  const [activePanel, setActivePanel] = useState<CanvasPanel>(null);
  const pendingRouteChangesRef = useRef<PendingWorkbenchRouteChange[]>([]);
  const preparedProjectRef = useRef<{
    activeTool: CanvasInteractionMode;
    projectId: string;
    prompt: string;
  } | null>(null);

  useEffect(() => subscribeWorkbenchCommittedUrl((href) => {
    setCommittedView(workbenchRouteView(new URL(href).pathname));
  }), []);

  const settlePendingRouteChanges = useCallback(() => {
    const currentHref = currentWorkbenchRouteHref();
    const matching = pendingRouteChangesRef.current.filter((item) => item.href === currentHref);
    for (const item of matching) finishPendingRouteChange(pendingRouteChangesRef, item);
  }, []);

  useEffect(() => {
    settlePendingRouteChanges();
  }, [pathname, routeSearch, settlePendingRouteChanges]);

  useEffect(() => () => {
    for (const item of pendingRouteChangesRef.current) {
      finishPendingRouteChange(
        pendingRouteChangesRef,
        item,
        new Error("Workbench route navigation was interrupted"),
      );
    }
    pendingRouteChangesRef.current = [];
  }, []);

  const resetProjectPresentation = useCallback((projectId: string) => {
    const prepared = preparedProjectRef.current?.projectId === projectId
      ? preparedProjectRef.current
      : null;
    preparedProjectRef.current = null;
    setPersistedPrompt(prepared?.prompt ?? "");
    setProjectDraft("");
    setActiveTool(prepared?.activeTool ?? "select");
    setActivePanel(null);
  }, []);

  const resetHomePresentation = useCallback(() => {
    preparedProjectRef.current = null;
    setPersistedPrompt("");
    setProjectDraft("");
    setActiveTool("select");
    setActivePanel(null);
  }, []);

  const navigateRoute = useCallback((href: string, signal?: AbortSignal) => {
    let nextHref: string;
    try {
      nextHref = normalizeWorkbenchRouteHref(href);
    } catch (error) {
      return Promise.reject(error);
    }
    if (workbenchRouteIsCommitted(nextHref)) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(workbenchNavigationAbortError());

    return new Promise<void>((resolve, reject) => {
      const pending: PendingWorkbenchRouteChange = {
        abortListener: null as (() => void) | null,
        frame: 0,
        href: nextHref,
        reject,
        resolve,
        signal: signal ?? null,
        timeout: window.setTimeout(() => {
          finishPendingRouteChange(
            pendingRouteChangesRef,
            pending,
            new Error("Workbench route navigation timed out"),
          );
        }, 15_000),
      };
      pending.abortListener = signal
        ? () => finishPendingRouteChange(
            pendingRouteChangesRef,
            pending,
            workbenchNavigationAbortError(),
          )
        : null;
      signal?.addEventListener("abort", pending.abortListener!, { once: true });
      pendingRouteChangesRef.current.push(pending);
      try {
        router.push(nextHref, { scroll: false });
        const checkRouteCommit = () => {
          if (!pendingRouteChangesRef.current.includes(pending)) return;
          if (workbenchRouteIsCommitted(pending.href)) {
            finishPendingRouteChange(pendingRouteChangesRef, pending);
            return;
          }
          pending.frame = window.requestAnimationFrame(checkRouteCommit);
        };
        pending.frame = window.requestAnimationFrame(checkRouteCommit);
      } catch (error) {
        finishPendingRouteChange(
          pendingRouteChangesRef,
          pending,
          error instanceof Error ? error : new Error("Workbench route navigation failed"),
        );
      }
    });
  }, [router]);

  const projectNavigation = useWorkbenchProjectNavigation({
    commitProjectOpen: workbench.commitProjectOpen,
    enabled: workbench.identityQuery.isSuccess,
    navigateRoute,
    onClose: resetHomePresentation,
    onError: () => {
      toast.error("项目画布尚未保存，已取消离开。请重试保存后再操作");
    },
    onOpen: resetProjectPresentation,
    prepareProjectClose: workbench.prepareProjectClose,
    prepareProjectOpen: workbench.prepareProjectOpen,
    prepareProjectRoute: preloadWorkbenchProjectRoute,
    selectedProjectId: workbench.selectedProjectId,
  });

  const prefetchProject = useCallback((projectId: string) => {
    if (!projectId) return;
    void preloadWorkbenchProjectRoute().catch(() => undefined);
    router.prefetch(createWorkbenchProjectPath(projectId));
  }, [router]);

  const openProject = useCallback((projectId: string) => {
    prefetchProject(projectId);
    return projectNavigation.openProject(projectId);
  }, [prefetchProject, projectNavigation]);

  const closeProject = useCallback(() => {
    router.prefetch("/");
    return projectNavigation.closeProject();
  }, [projectNavigation, router]);

  const commitCreatedProject = useCallback(async (projectId: string, prompt: string) => {
    preparedProjectRef.current = {
      activeTool: "pan",
      projectId,
      prompt,
    };
    prefetchProject(projectId);
    try {
      const opened = await projectNavigation.commitOpenedProject(projectId);
      if (!opened) throw new Error("The new Project route could not be opened");
    } catch (error) {
      if (preparedProjectRef.current?.projectId === projectId) {
        resetHomePresentation();
      }
      throw error;
    }
  }, [prefetchProject, projectNavigation, resetHomePresentation]);

  useEffect(() => {
    if (!workbench.submissionError) {
      toast.dismiss(WORKBENCH_SUBMISSION_ERROR_TOAST_ID);
      return;
    }
    toast.error(errorMessage(workbench.submissionError, "提交失败，请重试"), {
      id: WORKBENCH_SUBMISSION_ERROR_TOAST_ID,
    });
  }, [workbench.submissionError]);

  const contextValue = useMemo<WorkbenchRuntimeContextValue>(() => ({
    activePanel,
    activeTool,
    closeProject,
    commitCreatedProject,
    homeProjectTab,
    homePrompt,
    logout,
    openProject,
    persistedPrompt,
    projectDraft,
    projectSearch,
    routeView: committedView,
    setActivePanel,
    setActiveTool,
    setHomeProjectTab,
    setHomePrompt,
    setPersistedPrompt,
    setProjectDraft,
    setProjectSearch,
    user,
    workbench,
  }), [
    activePanel,
    activeTool,
    closeProject,
    commitCreatedProject,
    homeProjectTab,
    homePrompt,
    logout,
    openProject,
    persistedPrompt,
    projectDraft,
    projectSearch,
    committedView,
    user,
    workbench,
  ]);

  const finalizeSceneExit = useCallback((projectId: string) => {
    if (committedView !== "home") return;
    workbench.finalizeProjectClose(projectId);
  }, [committedView, workbench.finalizeProjectClose]);

  return (
    <WorkbenchCommittedRoute
      contextValue={contextValue}
      onExitComplete={finalizeSceneExit}
      routeView={committedView}
    />
  );
}

function WorkbenchCommittedRoute({
  contextValue,
  onExitComplete,
  routeView,
}: {
  contextValue: WorkbenchRuntimeContextValue;
  onExitComplete: (projectId: string) => void;
  routeView: WorkbenchRouteView;
}) {
  const { workbench } = contextValue;

  return (
    <main
      className="workbench-shell relative h-screen w-screen overflow-hidden bg-[var(--workbench-bg)] text-[#e5e2e3]"
      data-workbench-stage
    >
      <WorkbenchScene
        contextValue={contextValue}
        onExitComplete={onExitComplete}
        routeView={routeView}
      />
      <WorkbenchUploadList
        onCancelRecovery={workbench.cancelSubmissionRecovery}
        onCancel={workbench.cancelUpload}
        onPause={workbench.pauseUpload}
        onResume={workbench.resumeUpload}
        onRetryRecovery={workbench.retrySubmissionRecovery}
        onRetry={workbench.retryUpload}
        onSelectRecoveryFiles={(files) => workbench.selectSubmissionRecoveryFiles([...files])}
        placement={routeView}
        recovery={workbench.submissionRecovery}
        uploads={workbench.uploads}
      />
    </main>
  );
}

function workbenchRouteView(pathname: string): WorkbenchRouteView {
  return readWorkbenchProjectId({ href: `http://workbench.local${pathname}` })
    ? "project"
    : "home";
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function finishPendingRouteChange(
  pendingRef: { current: PendingWorkbenchRouteChange[] },
  pending: PendingWorkbenchRouteChange,
  error?: Error,
): void {
  if (!pendingRef.current.includes(pending)) return;
  pendingRef.current = pendingRef.current.filter((item) => item !== pending);
  window.clearTimeout(pending.timeout);
  window.cancelAnimationFrame(pending.frame);
  if (pending.signal && pending.abortListener) {
    pending.signal.removeEventListener("abort", pending.abortListener);
  }
  if (error) pending.reject(error);
  else pending.resolve();
}

function workbenchNavigationAbortError(): Error {
  return new DOMException("Workbench route navigation was aborted", "AbortError");
}
