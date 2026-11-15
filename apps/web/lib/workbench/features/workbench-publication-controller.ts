"use client";

import type {
  Board,
  ExportCapabilities,
  ExportFormat,
  ExportJob,
  ExportPackaging,
  ExportPreviewTokenResponse,
  ExportSelection,
  ProjectRelease,
  ProjectPreview,
} from "@workbench/workbench-contracts";
import { useCallback, useEffect } from "react";

import type { Versioned } from "../transport/contracts";
import {
  useWorkbenchProjectRef,
  useWorkbenchProjectSession,
  useWorkbenchProjectState,
} from "../project-session";
import type { BoardStore } from "./board";
import {
  useCancelWorkbenchExportJob,
  useCreateWorkbenchExportJob,
  useWorkbenchExportOperations,
  useWorkbenchExportCapabilities,
  useWorkbenchExportJobs,
  useWorkbenchExportJob,
  selectLatestRestorableExport,
  type WorkbenchExportOperations,
} from "./exports";
import {
  useCreateWorkbenchRelease,
  useWorkbenchReleases,
} from "./releases";
import {
  useRevokeWorkbenchProjectShareGrants,
  useRotateWorkbenchShareGrant,
  useWorkbenchShareGrants,
} from "./shares";
import {
  canonicalizeExportSelection,
  exportSelectionIdentityKey,
  exportSelectionsEqual,
  rebaseSavedPrdSelection,
  alignArtifactSelectionWithPins,
} from "./export-selection";
import { useWorkbenchPrdDraftStore } from "../prd-editor/draft-context";

export type WorkbenchExportTarget =
  | "Figma"
  | "MCP"
  | "Download .zip"
  | "Copy code"
  | "React"
  | "Download Word"
  | "Download PDF";

export type WorkbenchExportTargetDescriptor = {
  format: ExportFormat;
  packaging: ExportPackaging;
  delivery: "download" | "clipboard";
};

type PublishableBoardController = {
  store: BoardStore | null;
  save: () => Promise<Versioned<Board> | null>;
};

type ShareSession = {
  projectId: string;
  shareId: string;
  url: string;
  selectionKey: string;
};

type ActiveExportSession = {
  projectId: string;
  job: ExportJob;
};

const previewPollIntervalMs = 500;
const previewPollTimeoutMs = 2 * 60 * 1_000;

export function useWorkbenchPublicationController({
  boardController,
  canExport,
  canPreview,
  canShare,
  projectId,
}: {
  boardController: PublishableBoardController;
  canExport: boolean;
  canPreview: boolean;
  canShare: boolean;
  projectId: string;
}) {
  const session = useWorkbenchProjectSession(projectId);
  const prdDrafts = useWorkbenchPrdDraftStore();
  const exportOperations = useWorkbenchExportOperations();
  const releasesQuery = useWorkbenchReleases(canExport || canShare ? projectId : "", { limit: 100 });
  const sharesQuery = useWorkbenchShareGrants(canShare ? projectId : "", { limit: 100 });
  const createRelease = useCreateWorkbenchRelease(projectId);
  const rotateShare = useRotateWorkbenchShareGrant(projectId);
  const revokeProjectShares = useRevokeWorkbenchProjectShareGrants(projectId);
  const createExport = useCreateWorkbenchExportJob(projectId);
  const exportCapabilitiesQuery = useWorkbenchExportCapabilities();
  const exportJobsQuery = useWorkbenchExportJobs(
    canExport ? projectId : "",
    { limit: 100 },
  );
  const [shareSession, setShareSession] = useWorkbenchProjectState<ShareSession | null>(
    session,
    () => null,
  );
  const [activeExportSession, setActiveExportSession] = useWorkbenchProjectState<ActiveExportSession | null>(
    session,
    () => null,
  );
  const [shareOperationError, setShareOperationError] = useWorkbenchProjectState<unknown>(
    session,
    () => null,
  );
  const [exportOperationError, setExportOperationError] = useWorkbenchProjectState<unknown>(
    session,
    () => null,
  );
  const [previewOperationError, setPreviewOperationError] = useWorkbenchProjectState<unknown>(
    session,
    () => null,
  );
  const [downloadingExportState, setDownloadingExportState] = useWorkbenchProjectState<{
    projectId: string;
    operationId: number;
  } | null>(session, () => null);
  const [previewOperationCount, setPreviewOperationCount] = useWorkbenchProjectState(
    session,
    () => 0,
  );
  const previewIdsRef = useWorkbenchProjectRef(session, () => new Map<string, string>());
  const hydratedExportProjectRef = useWorkbenchProjectRef(session, () => "");
  const downloadOperationRef = useWorkbenchProjectRef(session, () => 0);
  const activeExportId = activeExportSession?.projectId === projectId
    ? activeExportSession.job.id
    : "";
  const activeExportQuery = useWorkbenchExportJob(projectId, activeExportId);
  const activeExport = activeExportSession?.projectId === projectId
    ? activeExportQuery.data?.value ?? activeExportSession.job
    : null;
  const activeExportSelection = activeExport?.selection ?? null;
  const cancelExport = useCancelWorkbenchExportJob(projectId, activeExportId);

  useEffect(() => {
    if (!canShare) setShareSession(null);
    if (!canExport) {
      setActiveExportSession(null);
      hydratedExportProjectRef.current = "";
    }
  }, [
    canExport,
    canShare,
    hydratedExportProjectRef,
    setActiveExportSession,
    setShareSession,
  ]);

  useEffect(() => {
    if (
      !projectId
      || !canExport
      || exportJobsQuery.isPending
      || exportJobsQuery.isError
      || exportJobsQuery.isPlaceholderData
      || hydratedExportProjectRef.current === projectId
    ) {
      return;
    }
    hydratedExportProjectRef.current = projectId;
    const restored = selectLatestRestorableExport(exportJobsQuery.data?.items);
    if (restored) {
      setActiveExportSession({ projectId, job: restored });
    }
  }, [
    canExport,
    exportJobsQuery.data,
    exportJobsQuery.isError,
    exportJobsQuery.isPending,
    exportJobsQuery.isPlaceholderData,
    hydratedExportProjectRef,
    projectId,
    setActiveExportSession,
  ]);

  const shareStateReady = canShare
    && sharesQuery.isSuccess
    && !sharesQuery.isPlaceholderData;
  const activeShareCount = shareStateReady ? sharesQuery.data.activeCount : 0;

  const ensureRelease = useCallback(async (): Promise<ProjectRelease> => {
    if (!projectId) throw new Error("Open a Project before publishing");
    await prdDrafts?.saveProject(projectId);
    const board = await flushWorkbenchBoard(boardController);
    const releases = (await releasesQuery.refetch()).data?.items ?? [];
    const existing = releases.find((release) => (
      release.status === "ready"
      && release.boardId === board.id
      && release.boardRevision === board.revision
    ));
    if (existing) return existing;

    const created = await createRelease.mutateAsync({
      request: { boardId: board.id, boardRevision: board.revision },
      ifMatch: `"${board.revision}"`,
    });
    return created.value;
  }, [boardController, createRelease, prdDrafts, projectId, releasesQuery]);

  const enableShare = useCallback(async () => {
    if (!canShare) throw new Error("This Project role cannot create Share grants");
    setShareOperationError(null);
    try {
      const selectedVersions = new Set(boardController.store?.getState().nodes
        .filter((node) => node.selected)
        .map((node) => node.workbench.artifactVersionId));
      const release = await ensureRelease();
      const selectionKey = shareSelectionKey(boardController.store);
      const prototypes = release.artifactPins.filter((pin) => pin.kind === "prototype"
        && (selectedVersions.size === 0 || selectedVersions.has(pin.artifactVersionId)));
      if (prototypes.length !== 1) throw new Error("请选择一个已完成的原型进行分享");
      const result = await rotateShare.mutateAsync({
        request: { releaseId: release.id, artifactVersionId: prototypes[0]!.artifactVersionId, scope: "view", expiresAt: null },
      });
      const sessionValue = {
        projectId,
        shareId: result.value.share.id,
        url: buildPublicShareUrl(result.value.token),
        selectionKey,
      };
      if (session.isCurrent()) setShareSession(sessionValue);
      return sessionValue.url;
    } catch (error) {
      if (session.isCurrent()) setShareOperationError(error);
      throw error;
    }
  }, [
    canShare,
    boardController,
    ensureRelease,
    projectId,
    rotateShare,
    session,
    setShareOperationError,
    setShareSession,
  ]);

  const disableShare = useCallback(async () => {
    if (!canShare) throw new Error("This Project role cannot revoke Share grants");
    setShareOperationError(null);
    try {
      await revokeProjectShares.mutateAsync();
      if (session.isCurrent()) setShareSession(null);
    } catch (error) {
      if (session.isCurrent()) setShareOperationError(error);
      throw error;
    }
  }, [
    canShare,
    revokeProjectShares,
    session,
    setShareOperationError,
    setShareSession,
  ]);

  const ensureShareLink = useCallback(async () => {
    if (!canShare) throw new Error("This Project role cannot create Share grants");
    if (shareSession?.projectId === projectId
      && !prdDrafts?.hasDrafts(projectId)
      && shareSession.selectionKey === shareSelectionKey(boardController.store)) return shareSession.url;
    return enableShare();
  }, [boardController.store, canShare, enableShare, prdDrafts, projectId, shareSession]);

  const toggleShare = useCallback(async () => {
    if (!canShare) throw new Error("This Project role cannot manage Share grants");
    if (!shareStateReady && shareSession?.projectId !== projectId) {
      const refreshed = await sharesQuery.refetch({ throwOnError: true });
      if ((refreshed.data?.activeCount ?? 0) > 0) {
        await disableShare();
        return null;
      }
      return enableShare();
    }
    if (activeShareCount > 0 || shareSession?.projectId === projectId) {
      await disableShare();
      return null;
    }
    return enableShare();
  }, [
    activeShareCount,
    canShare,
    disableShare,
    enableShare,
    projectId,
    sharesQuery,
    shareSession?.projectId,
    shareStateReady,
  ]);

  const startExport = useCallback(async (
    target: WorkbenchExportTarget,
    selection: ExportSelection,
  ): Promise<ExportJob> => {
    if (!canExport) throw new Error("This Project role cannot create Exports");
    const requestProjectId = projectId;
    setExportOperationError(null);
    try {
      const capabilities = exportCapabilitiesQuery.data
        ?? (await exportCapabilitiesQuery.refetch()).data;
      if (!capabilities || !exportTargetAvailability(capabilities, target).available) {
        throw new Error("The selected Export format is unavailable on this deployment");
      }
      const descriptor = exportTargetDescriptor(target);
      const savedDrafts = await prdDrafts?.saveProject(projectId) ?? [];
      const release = await ensureRelease();
      const canonicalSelection = canonicalizeExportSelection(alignArtifactSelectionWithPins(
        rebaseSavedPrdSelection(selection, savedDrafts), release.artifactPins,
      ));
      const result = await createExport.mutateAsync({
        request: {
          releaseId: release.id,
          format: descriptor.format,
          packaging: descriptor.packaging,
          selection: canonicalSelection,
          options: {},
        },
      });
      if (session.isCurrent()) {
        setActiveExportSession({ projectId: requestProjectId, job: result.value });
      }
      return result.value;
    } catch (error) {
      if (session.isCurrent()) setExportOperationError(error);
      throw error;
    }
  }, [
    canExport,
    createExport,
    ensureRelease,
    exportCapabilitiesQuery,
    prdDrafts,
    projectId,
    session,
    setActiveExportSession,
    setExportOperationError,
  ]);

  const cancelActiveExport = useCallback(async () => {
    if (!canExport) throw new Error("This Project role cannot cancel Exports");
    if (!activeExport || (activeExport.status !== "queued" && activeExport.status !== "running")) {
      throw new Error("The Export cannot be cancelled");
    }
    const requestProjectId = projectId;
    const requestExportId = activeExport.id;
    setExportOperationError(null);
    try {
      const result = await cancelExport.mutateAsync({
        // The revision in the persisted job is the same strong ETag exposed by
        // the API. Supplying it explicitly also works before the detail query
        // has completed after a refresh.
        ifMatch: `"${activeExport.revision}"`,
      });
      if (
        session.isCurrent()
        && activeExportSession?.projectId === requestProjectId
        && activeExportSession.job.id === requestExportId
      ) {
        setActiveExportSession({ projectId: requestProjectId, job: result.value });
      }
      return result;
    } catch (error) {
      if (session.isCurrent()) {
        setExportOperationError(error);
        void activeExportQuery.refetch();
      }
      throw error;
    }
  }, [
    activeExport,
    activeExportQuery,
    activeExportSession,
    canExport,
    cancelExport,
    projectId,
    session,
    setActiveExportSession,
    setExportOperationError,
  ]);

  const downloadExport = useCallback(async (job = activeExport) => {
    if (!canExport) throw new Error("This Project role cannot download Exports");
    if (!job || job.status !== "succeeded") {
      throw new Error("The Export is not ready to download");
    }
    const requestProjectId = projectId;
    const operationId = downloadOperationRef.current + 1;
    downloadOperationRef.current = operationId;
    setExportOperationError(null);
    setDownloadingExportState({ projectId: requestProjectId, operationId });
    try {
      const result = await exportOperations.getExportContent(job.id);
      // A response from a previous Project must never trigger a download in
      // the newly opened Project after navigation wins the race.
      if (session.isCurrent()) {
        downloadBlob(result.value, exportFileName(requestProjectId, job));
      }
    } catch (error) {
      if (session.isCurrent()) setExportOperationError(error);
      throw error;
    } finally {
      if (downloadOperationRef.current === operationId) setDownloadingExportState(null);
    }
  }, [
    activeExport,
    canExport,
    downloadOperationRef,
    exportOperations,
    projectId,
    session,
    setDownloadingExportState,
    setExportOperationError,
  ]);

  const copyExportCode = useCallback(async (job = activeExport) => {
    if (!canExport) throw new Error("This Project role cannot copy Exports");
    if (!job || job.status !== "succeeded" || job.format !== "html" || job.packaging !== "single_file") {
      throw new Error("Copy code requires a succeeded single-file HTML Export");
    }
    setExportOperationError(null);
    try {
      const result = await exportOperations.getExportContent(job.id);
      if (session.isCurrent()) await copyExportHtmlToClipboard(result.value);
    } catch (error) {
      if (session.isCurrent()) setExportOperationError(error);
      throw error;
    }
  }, [activeExport, canExport, exportOperations, session, setExportOperationError]);

  const createPreview = useCallback(async (
    selection: ExportSelection,
    signal?: AbortSignal,
  ): Promise<ExportPreviewTokenResponse> => {
    if (!canPreview) throw new Error("This Project role cannot create isolated Previews");
    throwIfPreviewAborted(signal);
    setPreviewOperationError(null);
    setPreviewOperationCount((count) => count + 1);
    try {
      const savedDrafts = await prdDrafts?.saveProject(projectId) ?? [];
      const board = await persistedPreviewBoard(boardController, canExport);
      const savedSelection = alignArtifactSelectionWithPins(
        rebaseSavedPrdSelection(selection, savedDrafts),
        boardController.store?.getState().nodes.map((node) => node.workbench) ?? [],
      );
      throwIfPreviewAborted(signal);
      const cacheKey = previewSelectionKey(`${board.id}:${board.revision}`, savedSelection);
      let previewId = previewIdsRef.current.get(cacheKey);
      let preview: ProjectPreview | null = null;

      if (previewId) {
        const current = await exportOperations.getProjectPreview(previewId);
        // Older responses store the opening screen outside the selection.
        const currentSelection = current.selection.kind === "artifact"
          && current.selection.screenId === undefined
          && current.initialScreenId != null
          ? { ...current.selection, screenId: current.initialScreenId }
          : current.selection;
        if (current.boardId === board.id
          && current.boardRevision === board.revision
          && exportSelectionsEqual(currentSelection, savedSelection)
          && current.status !== "failed"
          && current.status !== "cancelled"
          && current.status !== "expired") {
          preview = current;
        } else {
          previewIdsRef.current.delete(cacheKey);
          previewId = undefined;
        }
      }

      if (!preview) {
        const previewSelection: ExportSelection = savedSelection.kind === "artifact"
          ? {
              kind: "artifact",
              artifactId: savedSelection.artifactId,
              artifactVersionId: savedSelection.artifactVersionId,
            }
          : savedSelection;
        preview = await exportOperations.createProjectPreview(projectId, {
          boardId: board.id,
          boardRevision: board.revision,
          selection: previewSelection,
          initialScreenId: savedSelection.kind === "artifact" ? savedSelection.screenId ?? null : null,
        });
        previewId = preview.id;
        previewIdsRef.current.set(cacheKey, previewId);
      }

      const succeeded = await waitForProjectPreview(exportOperations, preview, {
        signal,
        intervalMs: previewPollIntervalMs,
        timeoutMs: previewPollTimeoutMs,
      });
      const capability = await exportOperations.createProjectPreviewToken(succeeded.id);
      return validateIsolatedPreviewCapability(capability);
    } catch (error) {
      if (session.isCurrent()) setPreviewOperationError(error);
      throw error;
    } finally {
      setPreviewOperationCount((count) => Math.max(0, count - 1));
    }
  }, [
    boardController,
    canExport,
    canPreview,
    exportOperations,
    previewIdsRef,
    prdDrafts,
    projectId,
    session,
    setPreviewOperationCount,
    setPreviewOperationError,
  ]);

  return {
    activeExport,
    activeExportSelection,
    activeExportQuery,
    busy: createRelease.isPending
      || rotateShare.isPending
      || revokeProjectShares.isPending
      || createExport.isPending
      || cancelExport.isPending
      || downloadingExportState?.projectId === projectId
      || previewOperationCount > 0,
    cancelExport: cancelActiveExport,
    copyExportCode,
    disableShare,
    downloadExport,
    enableShare,
    ensureShareLink,
    exportError: exportOperationError
      ?? createExport.error
      ?? activeExportQuery.error
      ?? exportJobsQuery.error,
    exportCapabilities: exportCapabilitiesQuery.data ?? null,
    exportCapabilitiesError: exportCapabilitiesQuery.error,
    exportCapabilitiesPending: exportCapabilitiesQuery.isPending,
    exportRunning: activeExport?.status === "queued" || activeExport?.status === "running",
    createPreview,
    previewError: previewOperationError,
    previewBusy: previewOperationCount > 0,
    retryExportCapabilities: exportCapabilitiesQuery.refetch,
    retryShareState: sharesQuery.refetch,
    shareEnabled: canShare && (
      (shareStateReady && activeShareCount > 0)
      || shareSession?.projectId === projectId
    ),
    shareError: shareOperationError
      ?? rotateShare.error
      ?? revokeProjectShares.error,
    shareStateError: sharesQuery.error,
    shareStatePending: canShare && (sharesQuery.isPending || sharesQuery.isPlaceholderData),
    shareUrl: shareSession?.projectId === projectId
      && shareSession.selectionKey === shareSelectionKey(boardController.store) ? shareSession.url : null,
    startExport,
    toggleShare,
  };
}

function shareSelectionKey(store: BoardStore | null): string {
  const state = store?.getState();
  return JSON.stringify([
    state?.boardId, state?.serverRevision, state?.dirty, state?.saveStatus,
    [...new Set(state?.nodes.filter((node) => node.selected)
      .map((node) => node.workbench.artifactVersionId))].sort(),
  ]);
}

export async function waitForProjectPreview(
  api: Pick<WorkbenchExportOperations, "getProjectPreview">,
  initialPreview: ProjectPreview,
  {
    signal,
    intervalMs = previewPollIntervalMs,
    timeoutMs = previewPollTimeoutMs,
  }: {
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<ProjectPreview> {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError("Preview poll interval must be a non-negative finite number");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Preview poll timeout must be a positive finite number");
  }

  const deadline = Date.now() + timeoutMs;
  let preview = initialPreview;
  while (preview.status === "queued" || preview.status === "running") {
    throwIfPreviewAborted(signal);
    if (Date.now() >= deadline) throw new Error("Timed out while preparing the isolated Preview");
    await previewDelay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
    throwIfPreviewAborted(signal);
    preview = await api.getProjectPreview(preview.id);
    if (preview.boardId !== initialPreview.boardId
      || preview.boardRevision !== initialPreview.boardRevision
      || !exportSelectionsEqual(preview.selection, initialPreview.selection)) {
      throw new Error("Preview identity changed while polling");
    }
  }
  if (preview.status === "succeeded") return preview;
  if (preview.status === "failed") {
    throw new Error(preview.failure?.detail || preview.failure?.code || "Preview build failed");
  }
  if (preview.status === "expired") throw new Error("Preview expired before it was ready");
  throw new Error("Preview was cancelled");
}

export function validateIsolatedPreviewCapability(
  capability: ExportPreviewTokenResponse,
  webOrigin = typeof window === "undefined" ? null : window.location.origin,
): ExportPreviewTokenResponse {
  const url = new URL(capability.url);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("Preview capability URL is invalid");
  }
  if (webOrigin && url.origin === new URL(webOrigin).origin) {
    throw new Error("Preview capability must use an origin independent from the Workbench");
  }
  if (Date.parse(capability.expiresAt) <= Date.now()) {
    throw new Error("Preview capability is already expired");
  }
  return capability;
}

export async function flushWorkbenchBoard(
  controller: PublishableBoardController,
): Promise<{ id: string; revision: number }> {
  const store = controller.store;
  if (!store) throw new Error("The Project Board is not ready");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = store.getState();
    if (state.saveStatus === "conflict") throw state.lastSaveError ?? new Error("Board revision conflict");
    if (!state.dirty && state.saveStatus === "clean") {
      return { id: state.boardId, revision: state.serverRevision };
    }
    if (state.saveStatus === "saving") {
      await waitForBoardSave(store);
    } else {
      await controller.save();
    }
  }
  throw new Error("The Project Board kept changing while it was being published");
}

async function persistedPreviewBoard(
  controller: PublishableBoardController,
  canPersist: boolean,
): Promise<{ id: string; revision: number }> {
  if (canPersist) return flushWorkbenchBoard(controller);
  const state = controller.store?.getState();
  if (!state) throw new Error("The Project Board is not ready");
  if (state.dirty || state.saveStatus !== "clean") {
    throw new Error("Only the persisted Project Board can be previewed");
  }
  return { id: state.boardId, revision: state.serverRevision };
}

export function exportTargetForFormat(
  format: ExportFormat,
  packaging: ExportPackaging = format === "html" ? "single_file" : "zip",
): WorkbenchExportTarget {
  if (format === "figma") return "Figma";
  if (format === "mcp") return "MCP";
  if (format === "react") return "React";
  if (format === "docx") return "Download Word";
  if (format === "pdf") return "Download PDF";
  return packaging === "zip" ? "Download .zip" : "Copy code";
}

export function exportTargetDescriptor(target: WorkbenchExportTarget): WorkbenchExportTargetDescriptor {
  const descriptors: Record<WorkbenchExportTarget, WorkbenchExportTargetDescriptor> = {
    Figma: { format: "figma", packaging: "zip", delivery: "download" },
    MCP: { format: "mcp", packaging: "zip", delivery: "download" },
    "Download .zip": { format: "html", packaging: "zip", delivery: "download" },
    "Copy code": { format: "html", packaging: "single_file", delivery: "clipboard" },
    React: { format: "react", packaging: "zip", delivery: "download" },
    "Download Word": { format: "docx", packaging: "single_file", delivery: "download" },
    "Download PDF": { format: "pdf", packaging: "single_file", delivery: "download" },
  };
  return descriptors[target];
}

export function exportTargetAvailability(
  capabilities: ExportCapabilities | null,
  target: WorkbenchExportTarget,
): { available: boolean; reason: string | null } {
  if (!capabilities) return { available: false, reason: "正在检查导出能力" };
  const descriptor = exportTargetDescriptor(target);
  const formatCapability = capabilities.formats[descriptor.format];
  const packagingCapability = capabilities.packaging[descriptor.packaging];
  if (!formatCapability.available) return { available: false, reason: capabilityReason(formatCapability.reasonCode) };
  if (!packagingCapability.available) return { available: false, reason: capabilityReason(packagingCapability.reasonCode) };
  return { available: true, reason: null };
}

function capabilityReason(reasonCode: string | null) {
  if (reasonCode === "EXPORT_FIGMA_UNAVAILABLE") return "当前部署尚未完成 Figma 导出验收";
  return "当前部署不支持此导出能力";
}

function buildPublicShareUrl(token: string): string {
  if (typeof window === "undefined") throw new Error("Share links can only be created in a browser");
  return `${window.location.origin}/share/${encodeURIComponent(token)}`;
}

export async function copyExportHtmlToClipboard(
  blob: Blob,
  clipboard: Pick<Clipboard, "writeText"> | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard,
) {
  if (!clipboard?.writeText) throw new Error("Clipboard access is unavailable");
  const code = await blob.text();
  if (!code.trim()) throw new Error("The generated HTML Export is empty");
  await clipboard.writeText(code);
}

function waitForBoardSave(store: BoardStore): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out while saving the Project Board"));
    }, 30_000);
    const unsubscribe = store.subscribe((state) => {
      if (state.saveStatus === "saving") return;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

function previewSelectionKey(snapshotId: string, selection: ExportSelection): string {
  return JSON.stringify([snapshotId, exportSelectionIdentityKey(selection)]);
}

function previewDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfPreviewAborted(signal);
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfPreviewAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function exportFileName(projectId: string, job: ExportJob): string {
  const extensions: Record<ExportFormat, string> = {
    figma: "zip",
    html: "html",
    react: "zip",
    mcp: "zip",
    docx: "docx",
    pdf: "pdf",
  };
  const extension = job.packaging === "zip" ? "zip" : extensions[job.format];
  return `workbench-${projectId}-${job.id}.${extension}`;
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
