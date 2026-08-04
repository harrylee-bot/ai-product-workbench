"use client";

import type {
  Board,
  ExternalExportDelivery,
  ExternalExportTarget,
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
} from "./export-selection";

export type WorkbenchExportTarget =
  | "AI Studio"
  | "Figma"
  | "MCP"
  | "Netlify"
  | "Lovable"
  | "Bolt"
  | "Download .zip"
  | "Copy code"
  | "React";

export type WorkbenchExportTargetDescriptor = {
  format: ExportFormat;
  packaging: ExportPackaging;
  delivery: "download" | "clipboard" | "external";
  externalTarget: ExternalExportTarget | null;
};

type PublishableBoardController = {
  store: BoardStore | null;
  save: () => Promise<Versioned<Board> | null>;
};

type ShareSession = {
  projectId: string;
  shareId: string;
  url: string;
};

type ActiveExportSession = {
  projectId: string;
  job: ExportJob;
};

type ActiveExternalDeliverySession = {
  projectId: string;
  delivery: ExternalExportDelivery;
};

type ExternalDeliveryErrorOwnership = {
  value: unknown;
};

const previewPollIntervalMs = 500;
const previewPollTimeoutMs = 2 * 60 * 1_000;
const externalDeliveryPollIntervalMs = 1_000;
const externalDeliveryPollMaxRetryDelayMs = 30_000;

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
  const [activeExternalDeliverySession, setActiveExternalDeliverySession] = useWorkbenchProjectState<ActiveExternalDeliverySession | null>(
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
  const [externalDeliveryOperationPending, setExternalDeliveryOperationPending] = useWorkbenchProjectState(
    session,
    () => false,
  );
  const [previewOperationCount, setPreviewOperationCount] = useWorkbenchProjectState(
    session,
    () => 0,
  );
  const previewIdsRef = useWorkbenchProjectRef(session, () => new Map<string, string>());
  const hydratedExportProjectRef = useWorkbenchProjectRef(session, () => "");
  const hydratedExternalDeliveryRef = useWorkbenchProjectRef(session, () => "");
  const downloadOperationRef = useWorkbenchProjectRef(session, () => 0);
  const externalDeliveryOperationRef = useWorkbenchProjectRef(session, () => false);
  const currentExportIdRef = useWorkbenchProjectRef(session, () => "");
  const currentExternalDeliveryIdentityRef = useWorkbenchProjectRef(session, () => "");
  const externalDeliveryPollErrorRef = useWorkbenchProjectRef<ExternalDeliveryErrorOwnership | null>(
    session,
    () => null,
  );
  const externalDeliveryHydrationErrorRef = useWorkbenchProjectRef<ExternalDeliveryErrorOwnership | null>(
    session,
    () => null,
  );
  const activeExportId = activeExportSession?.projectId === projectId
    ? activeExportSession.job.id
    : "";
  const activeExportQuery = useWorkbenchExportJob(projectId, activeExportId);
  const activeExport = activeExportSession?.projectId === projectId
    ? activeExportQuery.data?.value ?? activeExportSession.job
    : null;
  const activeExportSelection = activeExport?.selection ?? null;
  const activeExternalDelivery = activeExternalDeliverySession?.projectId === projectId
    ? activeExternalDeliverySession.delivery
    : null;
  currentExportIdRef.current = activeExport?.id ?? "";
  const commitActiveExternalDelivery = useCallback((delivery: ExternalExportDelivery | null) => {
    currentExternalDeliveryIdentityRef.current = externalDeliveryPollingIdentity(projectId, delivery);
    const pollError = externalDeliveryPollErrorRef.current;
    const hydrationError = externalDeliveryHydrationErrorRef.current;
    externalDeliveryPollErrorRef.current = null;
    externalDeliveryHydrationErrorRef.current = null;
    if (pollError || hydrationError) {
      setExportOperationError((current: unknown) => (
        (pollError && Object.is(current, pollError.value))
        || (hydrationError && Object.is(current, hydrationError.value))
          ? null
          : current
      ));
    }
    setActiveExternalDeliverySession(delivery ? { projectId, delivery } : null);
  }, [
    currentExternalDeliveryIdentityRef,
    externalDeliveryHydrationErrorRef,
    externalDeliveryPollErrorRef,
    projectId,
    setActiveExternalDeliverySession,
    setExportOperationError,
  ]);
  const cancelExport = useCancelWorkbenchExportJob(projectId, activeExportId);

  useEffect(() => {
    if (!canShare) setShareSession(null);
    if (!canExport) {
      setActiveExportSession(null);
      commitActiveExternalDelivery(null);
      hydratedExportProjectRef.current = "";
      hydratedExternalDeliveryRef.current = "";
    }
  }, [
    canExport,
    canShare,
    commitActiveExternalDelivery,
    hydratedExportProjectRef,
    hydratedExternalDeliveryRef,
    setActiveExportSession,
    setShareSession,
  ]);

  useEffect(() => {
    if (!canExport || !activeExport || activeExport.status !== "succeeded") return;
    const exportId = activeExport.id;
    const hydrationKey = `${projectId}:${exportId}`;
    if (hydratedExternalDeliveryRef.current === hydrationKey) return;
    hydratedExternalDeliveryRef.current = hydrationKey;
    const deliveryIdentity = currentExternalDeliveryIdentityRef.current;
    let completed = false;
    let consecutiveFailures = 0;
    let disposed = false;
    let timer: number | null = null;
    const isCurrent = () => !disposed
      && session.isCurrent()
      && currentExportIdRef.current === exportId
      && hydratedExternalDeliveryRef.current === hydrationKey
      && currentExternalDeliveryIdentityRef.current === deliveryIdentity;
    const scheduleRetry = (): void => {
      if (!isCurrent()) return;
      timer = window.setTimeout(() => {
        timer = null;
        void hydrate();
      }, externalDeliveryRetryDelay(consecutiveFailures));
    };
    const hydrate = async (): Promise<void> => {
      try {
        const result = await exportOperations.listExternalExportDeliveries(exportId);
        if (!isCurrent()) return;
        consecutiveFailures = 0;
        const restored = selectLatestRestorableExternalDelivery(result.items);
        completed = true;
        commitActiveExternalDelivery(restored);
      } catch (error) {
        if (!isCurrent()) return;
        consecutiveFailures += 1;
        const previousError = externalDeliveryHydrationErrorRef.current;
        const nextError = { value: error };
        externalDeliveryHydrationErrorRef.current = nextError;
        setExportOperationError((current: unknown) => (
          current === null
          || (previousError && Object.is(current, previousError.value))
            ? error
            : current
        ));
        scheduleRetry();
      }
    };
    void hydrate();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      if (!completed && hydratedExternalDeliveryRef.current === hydrationKey) {
        hydratedExternalDeliveryRef.current = "";
      }
    };
  }, [
    activeExport,
    canExport,
    commitActiveExternalDelivery,
    currentExternalDeliveryIdentityRef,
    currentExportIdRef,
    exportOperations,
    externalDeliveryHydrationErrorRef,
    hydratedExternalDeliveryRef,
    projectId,
    session,
    setExportOperationError,
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

  useEffect(() => {
    if (!canExport || !activeExternalDelivery || !externalDeliveryNeedsPolling(activeExternalDelivery)) return;

    // One abortable chain owns retries for this exact persisted delivery revision.
    const deliveryId = activeExternalDelivery.id;
    const exportJobId = activeExternalDelivery.exportJobId;
    const deliveryRevision = activeExternalDelivery.revision;
    const deliveryStatus = activeExternalDelivery.status;
    const pollingIdentity = externalDeliveryPollingIdentity(projectId, activeExternalDelivery);
    const controller = new AbortController();
    let consecutiveFailures = 0;
    let timer: number | null = null;

    const isCurrent = () => (
      !controller.signal.aborted
      && session.isCurrent()
      && currentExternalDeliveryIdentityRef.current === pollingIdentity
    );
    const schedule = (delayMs: number): void => {
      if (!isCurrent()) return;
      timer = window.setTimeout(() => {
        timer = null;
        void poll();
      }, delayMs);
    };
    const poll = async (): Promise<void> => {
      try {
        const result = await exportOperations.getExternalExportDelivery(
          deliveryId,
          controller.signal,
        );
        if (!isCurrent()) return;
        if (result.value.id !== deliveryId
          || result.value.exportJobId !== exportJobId
          || result.etag !== `"${result.value.revision}"`) {
          throw new Error("External Export delivery identity changed while polling");
        }
        if (result.value.revision < deliveryRevision
          || (result.value.revision === deliveryRevision && result.value.status !== deliveryStatus)) {
          throw new Error("External Export delivery revision regressed while polling");
        }

        consecutiveFailures = 0;
        commitActiveExternalDelivery(result.value);
        if (externalDeliveryNeedsPolling(result.value)) {
          schedule(externalDeliveryPollIntervalMs);
        }
      } catch (error) {
        if (!isCurrent()) return;
        consecutiveFailures += 1;
        const previousError = externalDeliveryPollErrorRef.current;
        const nextError = { value: error };
        externalDeliveryPollErrorRef.current = nextError;
        setExportOperationError((current: unknown) => (
          current === null
          || (previousError && Object.is(current, previousError.value))
            ? error
            : current
        ));
        schedule(externalDeliveryRetryDelay(consecutiveFailures));
      }
    };

    schedule(externalDeliveryPollIntervalMs);
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    activeExternalDelivery,
    canExport,
    commitActiveExternalDelivery,
    currentExternalDeliveryIdentityRef,
    externalDeliveryPollErrorRef,
    exportOperations,
    projectId,
    session,
    setExportOperationError,
  ]);

  const beginExternalDeliveryOperation = useCallback(() => {
    if (externalDeliveryOperationRef.current) {
      throw new Error("An external Export delivery operation is already in progress");
    }
    externalDeliveryOperationRef.current = true;
    setExternalDeliveryOperationPending(true);
    return () => {
      externalDeliveryOperationRef.current = false;
      if (session.isCurrent()) setExternalDeliveryOperationPending(false);
    };
  }, [
    externalDeliveryOperationRef,
    session,
    setExternalDeliveryOperationPending,
  ]);

  const shareStateReady = canShare
    && sharesQuery.isSuccess
    && !sharesQuery.isPlaceholderData;
  const activeShareCount = shareStateReady ? sharesQuery.data.activeCount : 0;

  const ensureRelease = useCallback(async (): Promise<ProjectRelease> => {
    if (!projectId) throw new Error("Open a Project before publishing");
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
  }, [boardController, createRelease, projectId, releasesQuery]);

  const enableShare = useCallback(async () => {
    if (!canShare) throw new Error("This Project role cannot create Share grants");
    setShareOperationError(null);
    try {
      const release = await ensureRelease();
      const result = await rotateShare.mutateAsync({
        request: { releaseId: release.id, scope: "remix", expiresAt: null },
      });
      const sessionValue = {
        projectId,
        shareId: result.value.share.id,
        url: buildPublicShareUrl(result.value.token),
      };
      if (session.isCurrent()) setShareSession(sessionValue);
      return sessionValue.url;
    } catch (error) {
      if (session.isCurrent()) setShareOperationError(error);
      throw error;
    }
  }, [
    canShare,
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
    if (shareSession?.projectId === projectId) return shareSession.url;
    return enableShare();
  }, [canShare, enableShare, projectId, shareSession]);

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
      const release = await ensureRelease();
      const canonicalSelection = canonicalizeExportSelection(selection);
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
        commitActiveExternalDelivery(null);
        hydratedExternalDeliveryRef.current = `${requestProjectId}:${result.value.id}`;
      }
      return result.value;
    } catch (error) {
      if (session.isCurrent()) setExportOperationError(error);
      throw error;
    }
  }, [
    canExport,
    commitActiveExternalDelivery,
    createExport,
    ensureRelease,
    exportCapabilitiesQuery,
    hydratedExternalDeliveryRef,
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

  const prepareExternalDelivery = useCallback(async (target: WorkbenchExportTarget) => {
    if (!canExport) throw new Error("This Project role cannot publish Exports");
    const descriptor = exportTargetDescriptor(target);
    if (descriptor.delivery !== "external" || descriptor.externalTarget === null) {
      throw new Error("The selected Export target is not external");
    }
    if (!activeExport
      || activeExport.status !== "succeeded"
      || activeExport.format !== descriptor.format
      || activeExport.packaging !== descriptor.packaging) {
      throw new Error("Build the immutable Export output before preparing external delivery");
    }
    const finishOperation = beginExternalDeliveryOperation();
    setExportOperationError(null);
    try {
      const result = await exportOperations.createExternalExportDelivery(
        activeExport.id,
        { target: descriptor.externalTarget },
      );
      if (session.isCurrent()) {
        commitActiveExternalDelivery(result.value);
      }
      return result.value;
    } catch (error) {
      if (session.isCurrent()) setExportOperationError(error);
      throw error;
    } finally {
      finishOperation();
    }
  }, [
    activeExport,
    beginExternalDeliveryOperation,
    canExport,
    commitActiveExternalDelivery,
    exportOperations,
    projectId,
    session,
    setExportOperationError,
  ]);

  const mutateExternalDelivery = useCallback(async (
    action: "confirm" | "retry" | "cancel",
    target: WorkbenchExportTarget,
  ) => {
    if (!activeExternalDelivery) throw new Error("No external delivery is active");
    const descriptor = exportTargetDescriptor(target);
    if (descriptor.externalTarget === null
      || descriptor.externalTarget !== activeExternalDelivery.target
      || !activeExport
      || activeExternalDelivery.exportJobId !== activeExport.id) {
      throw new Error("The active external delivery does not match the selected Export target");
    }
    const requestDelivery = activeExternalDelivery;
    const requestIdentity = externalDeliveryPollingIdentity(projectId, requestDelivery);
    const finishOperation = beginExternalDeliveryOperation();
    setExportOperationError(null);
    try {
      const etag = `"${requestDelivery.revision}"`;
      const result = action === "confirm"
        ? await exportOperations.confirmExternalExportDelivery(requestDelivery.id, etag)
        : action === "retry"
          ? await exportOperations.retryExternalExportDelivery(requestDelivery.id, etag)
          : await exportOperations.cancelExternalExportDelivery(requestDelivery.id, etag);
      if (session.isCurrent() && currentExternalDeliveryIdentityRef.current === requestIdentity) {
        if (result.value.id !== requestDelivery.id
          || result.value.exportJobId !== requestDelivery.exportJobId
          || result.value.revision < requestDelivery.revision
          || (result.value.revision === requestDelivery.revision
            && result.value.status !== requestDelivery.status)
          || result.etag !== `"${result.value.revision}"`) {
          throw new Error("External Export delivery mutation response was stale");
        }
        commitActiveExternalDelivery(result.value);
      }
      return result.value;
    } catch (error) {
      if (session.isCurrent() && currentExternalDeliveryIdentityRef.current === requestIdentity) {
        setExportOperationError(error);
      }
      throw error;
    } finally {
      finishOperation();
    }
  }, [
    activeExternalDelivery,
    activeExport,
    beginExternalDeliveryOperation,
    commitActiveExternalDelivery,
    currentExternalDeliveryIdentityRef,
    exportOperations,
    projectId,
    session,
    setExportOperationError,
  ]);

  const createPreview = useCallback(async (
    selection: ExportSelection,
    signal?: AbortSignal,
  ): Promise<ExportPreviewTokenResponse> => {
    if (!canPreview) throw new Error("This Project role cannot create isolated Previews");
    throwIfPreviewAborted(signal);
    setPreviewOperationError(null);
    setPreviewOperationCount((count) => count + 1);
    try {
      const board = await persistedPreviewBoard(boardController, canExport);
      throwIfPreviewAborted(signal);
      const cacheKey = previewSelectionKey(`${board.id}:${board.revision}`, selection);
      let previewId = previewIdsRef.current.get(cacheKey);
      let preview: ProjectPreview | null = null;

      if (previewId) {
        const current = await exportOperations.getProjectPreview(previewId);
        if (current.boardId === board.id
          && current.boardRevision === board.revision
          && exportSelectionsEqual(current.selection, selection)
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
        preview = await exportOperations.createProjectPreview(projectId, {
          boardId: board.id,
          boardRevision: board.revision,
          selection,
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
    projectId,
    session,
    setPreviewOperationCount,
    setPreviewOperationError,
  ]);

  return {
    activeExport,
    activeExportSelection,
    activeExternalDelivery,
    activeExportQuery,
    busy: createRelease.isPending
      || rotateShare.isPending
      || revokeProjectShares.isPending
      || createExport.isPending
      || cancelExport.isPending
      || externalDeliveryOperationPending
      || downloadingExportState?.projectId === projectId
      || previewOperationCount > 0,
    cancelExport: cancelActiveExport,
    cancelExternalDelivery: (target: WorkbenchExportTarget) => mutateExternalDelivery("cancel", target),
    confirmExternalDelivery: (target: WorkbenchExportTarget) => mutateExternalDelivery("confirm", target),
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
    retryExternalDelivery: (target: WorkbenchExportTarget) => mutateExternalDelivery("retry", target),
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
    shareUrl: shareSession?.projectId === projectId ? shareSession.url : null,
    startExport,
    prepareExternalDelivery,
    toggleShare,
  };
}

function externalDeliveryNeedsPolling(delivery: ExternalExportDelivery): boolean {
  return delivery.status === "queued"
    || delivery.status === "running"
    || delivery.status === "cancelling";
}

function externalDeliveryPollingIdentity(
  projectId: string,
  delivery: ExternalExportDelivery | null,
): string {
  return delivery
    ? `${projectId}:${delivery.id}:${delivery.exportJobId}:${delivery.revision}:${delivery.status}`
    : "";
}

function externalDeliveryRetryDelay(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(0, consecutiveFailures - 1), 10);
  return Math.min(
    externalDeliveryPollIntervalMs * (2 ** exponent),
    externalDeliveryPollMaxRetryDelayMs,
  );
}

export async function waitForPreviewExport(
  api: Pick<WorkbenchExportOperations, "getExportJob">,
  initialJob: ExportJob,
  {
    signal,
    intervalMs = previewPollIntervalMs,
    timeoutMs = previewPollTimeoutMs,
  }: {
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<ExportJob> {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError("Preview poll interval must be a non-negative finite number");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Preview poll timeout must be a positive finite number");
  }
  if (initialJob.format !== "html") throw new Error("Only HTML Exports can be previewed");

  const deadline = Date.now() + timeoutMs;
  let job = initialJob;
  while (job.status === "queued" || job.status === "running") {
    throwIfPreviewAborted(signal);
    if (Date.now() >= deadline) throw new Error("Timed out while preparing the isolated Preview");
    await previewDelay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
    throwIfPreviewAborted(signal);
    job = (await api.getExportJob(job.id)).value;
    if (job.format !== "html" || job.id !== initialJob.id) {
      throw new Error("Preview Export identity changed while polling");
    }
  }
  if (job.status === "succeeded") return job;
  if (job.status === "failed") {
    throw new Error(job.failure?.detail || job.failure?.code || "Preview Export failed");
  }
  throw new Error("Preview Export was cancelled");
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

export async function persistedPreviewBoard(
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

export function exportFormatForTarget(target: WorkbenchExportTarget): ExportFormat {
  return exportTargetDescriptor(target).format;
}

export function exportTargetForFormat(
  format: ExportFormat,
  packaging: ExportPackaging = format === "html" ? "single_file" : "zip",
): WorkbenchExportTarget {
  if (format === "figma") return "Figma";
  if (format === "mcp") return "MCP";
  if (format === "react") return "React";
  return packaging === "zip" ? "Download .zip" : "Copy code";
}

export function exportTargetForExternalDelivery(target: ExternalExportTarget): WorkbenchExportTarget {
  const targets: Record<ExternalExportTarget, WorkbenchExportTarget> = {
    ai_studio: "AI Studio",
    netlify: "Netlify",
    lovable: "Lovable",
    bolt: "Bolt",
  };
  return targets[target];
}

export function selectLatestRestorableExternalDelivery(
  deliveries: readonly ExternalExportDelivery[] | undefined,
): ExternalExportDelivery | null {
  const latest = deliveries?.[0];
  return latest && latest.status !== "cancelled" ? latest : null;
}

export function exportTargetDescriptor(target: WorkbenchExportTarget): WorkbenchExportTargetDescriptor {
  const descriptors: Record<WorkbenchExportTarget, WorkbenchExportTargetDescriptor> = {
    "AI Studio": { format: "react", packaging: "zip", delivery: "external", externalTarget: "ai_studio" },
    Figma: { format: "figma", packaging: "zip", delivery: "download", externalTarget: null },
    MCP: { format: "mcp", packaging: "zip", delivery: "download", externalTarget: null },
    Netlify: { format: "html", packaging: "zip", delivery: "external", externalTarget: "netlify" },
    Lovable: { format: "react", packaging: "zip", delivery: "external", externalTarget: "lovable" },
    Bolt: { format: "react", packaging: "zip", delivery: "external", externalTarget: "bolt" },
    "Download .zip": { format: "html", packaging: "zip", delivery: "download", externalTarget: null },
    "Copy code": { format: "html", packaging: "single_file", delivery: "clipboard", externalTarget: null },
    React: { format: "react", packaging: "zip", delivery: "download", externalTarget: null },
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
  if (descriptor.externalTarget) {
    const capability = capabilities.external[descriptor.externalTarget];
    if (!capability.available || capability.authentication === "required") {
      return { available: false, reason: capabilityReason(capability.reasonCode) };
    }
  }
  return { available: true, reason: null };
}

function capabilityReason(reasonCode: string | null) {
  if (reasonCode === "EXPORT_EXTERNAL_AUTHENTICATION_REQUIRED") return "需要先完成企业账号授权";
  if (reasonCode === "EXPORT_EXTERNAL_AI_STUDIO_UNAVAILABLE") return "当前部署未启用 AI Studio 发布";
  if (reasonCode === "EXPORT_FIGMA_UNAVAILABLE") return "当前部署尚未完成 Figma 导出验收";
  return "当前部署不支持此导出能力";
}

export function buildPublicShareUrl(token: string): string {
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
