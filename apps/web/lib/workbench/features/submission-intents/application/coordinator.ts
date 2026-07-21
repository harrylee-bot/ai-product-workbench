"use client";

import {
  createSubmissionIntentRequestSchema,
  type CreateSubmissionIntentRequest,
  type Run,
  type SubmissionIntent,
  type SubmissionIntentRunRequest,
  type SubmitSubmissionIntentResponse,
} from "@workbench/workbench-contracts";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  WorkbenchUploadBatchResult,
  WorkbenchUploadInput,
} from "../../files";
import { workbenchQueryKeys } from "../../../query/keys";
import {
  createIdempotencyKey,
  type Versioned,
} from "../../../transport/contracts";
import { useWorkbenchSubmissionIntentsApi } from "../api-adapter";
import {
  canReplaySubmissionIntentSubmit,
  selectSubmissionIntentReselectionSlots,
  submissionIntentRecoveryState,
} from "../domain";
import {
  refreshCurrentWorkbenchSubmissionIntent,
  replaceCurrentWorkbenchSubmissionIntent,
} from "./current-intent-cache";

export type WorkbenchPreparedSubmission = {
  files?: readonly File[];
  request: SubmissionIntentRunRequest;
};

export type WorkbenchSubmissionPlan = {
  request: CreateSubmissionIntentRequest;
  uploads: readonly {
    clientFingerprint: string;
    file: File;
    position: number;
  }[];
};

export type WorkbenchSubmissionRecovery = {
  actionPending: boolean;
  cancellable: boolean;
  error: string | null;
  files: readonly {
    byteSize: number;
    fileName: string;
    position: number;
  }[];
  kind: "failed" | "processing" | "waiting_files";
  message: string;
  retryable: boolean;
};

export type WorkbenchSubmissionUploadPort = {
  completeUploadBatch(batchId: string | null): void;
  releaseProjectUploads(projectId: string): void;
  uploadFiles(
    projectId: string,
    inputs: readonly WorkbenchUploadInput[],
  ): Promise<WorkbenchUploadBatchResult>;
};

export type WorkbenchSubmissionCoordinatorOptions = {
  currentIntent: SubmissionIntent | null;
  onRun: (run: Run) => void;
  projectId: string;
  uploads: WorkbenchSubmissionUploadPort;
};

type WorkbenchSubmissionActionState = {
  error: unknown;
  intentId: string | null;
  pending: boolean;
  token: symbol;
};

type WorkbenchSubmissionAction = {
  intentId: string | null;
  token: symbol;
};

type WorkbenchSubmissionActionContext = {
  setIntentId: (intentId: string) => void;
};

type SubmissionIntentReceipt = Versioned<SubmitSubmissionIntentResponse>;

type SubmissionIntentClientState = {
  acceptedSubmissions: Map<string, Promise<Run>>;
  automaticReplayAttempts: Set<string>;
};

type SubmissionIntentRegistry = {
  clientStates: WeakMap<QueryClient, SubmissionIntentClientState>;
  inFlight: Map<string, Promise<SubmissionIntentReceipt>>;
  networkSubmissionAttempts: Set<string>;
  settled: Map<string, SubmissionIntentReceipt>;
};

const MAX_REMEMBERED_SUBMISSIONS = 512;
let submissionIntentRegistry = createSubmissionIntentRegistry();

export function useWorkbenchSubmissionCoordinator({
  currentIntent,
  onRun,
  projectId,
  uploads,
}: WorkbenchSubmissionCoordinatorOptions) {
  const service = useWorkbenchSubmissionIntentsApi();
  const queryClient = useQueryClient();
  const submissionRegistry = submissionIntentRegistry;
  const submissionClientState = submissionClientStateFor(submissionRegistry, queryClient);
  const { acceptedSubmissions, automaticReplayAttempts } = submissionClientState;
  const onRunRef = useRef(onRun);
  const actionsRef = useRef(new Map<string, WorkbenchSubmissionAction>());
  const cancelledIntentIds = useRef(new Set<string>());
  const pendingBatches = useRef(new Map<string, string | null>());
  const cancellationActionsRef = useRef(new Map<string, symbol>());
  const [actionStates, setActionStates] = useState(
    () => new Map<string, WorkbenchSubmissionActionState>(),
  );
  const [cancellationIntentIds, setCancellationIntentIds] = useState(
    () => new Set<string>(),
  );
  useLayoutEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  const refreshCurrent = useCallback(async (targetThreadId: string) => {
    const current = await refreshCurrentWorkbenchSubmissionIntent(
      queryClient,
      targetThreadId,
      (signal) => service.getCurrentSubmissionIntent(targetThreadId, signal),
    );
    return current?.item;
  }, [queryClient, service]);

  const acceptReceipt = useCallback(async (
    targetProjectId: string,
    targetThreadId: string,
    result: Versioned<SubmitSubmissionIntentResponse>,
  ) => {
    const { intent, run } = result.value;
    rememberAutomaticReplayAttempt(automaticReplayAttempts, intent.id);
    queryClient.setQueryData(
      workbenchQueryKeys.submissionIntent(intent.id),
      { value: intent, etag: result.etag },
    );
    await replaceCurrentWorkbenchSubmissionIntent(
      queryClient,
      targetThreadId,
      { item: null },
    );
    queryClient.setQueryData(workbenchQueryKeys.run(run.id), run);
    onRunRef.current(run);
    uploads.completeUploadBatch(pendingBatches.current.get(intent.id) ?? null);
    pendingBatches.current.delete(intent.id);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.currentSubmissionIntent(targetThreadId),
      }),
      queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(targetProjectId) }),
      queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.runLists(targetProjectId, targetThreadId),
      }),
      queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.entryLists(targetProjectId, targetThreadId),
      }),
      queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.thread(targetProjectId, targetThreadId),
      }),
    ]);
    return run;
  }, [automaticReplayAttempts, queryClient, uploads]);

  const submitIntent = useCallback(async (
    intent: SubmissionIntent,
  ) => {
    const existingAcceptance = acceptedSubmissions.get(intent.id);
    if (existingAcceptance) return existingAcceptance;

    const settledReceipt = submissionRegistry.settled.get(intent.id);
    let receipt = settledReceipt ? Promise.resolve(settledReceipt) : undefined;
    receipt ??= submissionRegistry.inFlight.get(intent.id);
    if (!receipt) {
      rememberAutomaticReplayAttempt(submissionRegistry.networkSubmissionAttempts, intent.id);
      const requestedReceipt: Promise<SubmissionIntentReceipt> = Promise.resolve()
        .then(() => service.submitSubmissionIntent(intent.id))
        .then((result) => rememberSettledSubmission(submissionRegistry, intent, result))
        .finally(() => {
          if (submissionRegistry.inFlight.get(intent.id) === requestedReceipt) {
            submissionRegistry.inFlight.delete(intent.id);
          }
        });
      submissionRegistry.inFlight.set(intent.id, requestedReceipt);
      receipt = requestedReceipt;
    }

    const acceptance: Promise<Run> = receipt
      .then((result) => acceptReceipt(intent.projectId, intent.threadId, result))
      .catch((error: unknown) => {
        if (acceptedSubmissions.get(intent.id) === acceptance) {
          acceptedSubmissions.delete(intent.id);
        }
        throw error;
      });
    rememberBounded(acceptedSubmissions, intent.id, acceptance);
    return acceptance;
  }, [acceptReceipt, acceptedSubmissions, service, submissionRegistry]);

  const runAction = useCallback(async <Result,>(
    targetProjectId: string,
    operation: (context: WorkbenchSubmissionActionContext) => Promise<Result>,
    intentId: string | null = null,
  ): Promise<Result> => {
    if (!targetProjectId) throw new Error("A submission action requires a Project");
    if (actionsRef.current.has(targetProjectId)) {
      throw new Error("A submission action is already running for this Project");
    }
    const token = Symbol(targetProjectId);
    const action = { intentId, token };
    actionsRef.current.set(targetProjectId, action);
    setActionStates((current) => {
      const next = new Map(current);
      next.set(targetProjectId, { error: null, intentId, pending: true, token });
      return next;
    });
    const setIntentId = (nextIntentId: string) => {
      if (actionsRef.current.get(targetProjectId)?.token !== token) return;
      action.intentId = nextIntentId;
      setActionStates((current) => updateActionState(
        current,
        targetProjectId,
        token,
        (state) => ({ ...state, intentId: nextIntentId }),
      ));
    };
    let failed = false;
    try {
      return await operation({ setIntentId });
    } catch (error) {
      failed = true;
      setActionStates((current) => updateActionState(
        current,
        targetProjectId,
        token,
        (state) => ({ ...state, error }),
      ));
      throw error;
    } finally {
      if (actionsRef.current.get(targetProjectId)?.token === token) {
        actionsRef.current.delete(targetProjectId);
      }
      setActionStates((current) => failed
        ? updateActionState(
            current,
            targetProjectId,
            token,
            (state) => ({ ...state, pending: false }),
          )
        : removeActionState(current, targetProjectId, token));
    }
  }, []);

  const submitPrepared = useCallback(async ({
    projectId: targetProjectId,
    threadId: targetThreadId,
    submission,
  }: {
    projectId: string;
    threadId: string;
    submission: WorkbenchPreparedSubmission;
  }) => {
    if (currentIntent?.projectId === targetProjectId) {
      throw new Error("Resolve the current SubmissionIntent before starting another submission");
    }
    return runAction(targetProjectId, async ({ setIntentId }) => {
      const plan = createWorkbenchSubmissionPlan(submission);
      const created = await service.createSubmissionIntent(
        targetThreadId,
        plan.request,
        createIdempotencyKey("submission"),
      );
      setIntentId(created.value.id);
      await replaceCurrentWorkbenchSubmissionIntent(
        queryClient,
        targetThreadId,
        { item: created.value },
        created,
      );
      const intent = created.value;
      try {
        const uploaded = await uploads.uploadFiles(
          targetProjectId,
          submissionUploadInputs(intent, plan.uploads),
        );
        pendingBatches.current.set(intent.id, uploaded.batchId);
        return await submitIntent(intent);
      } catch (error) {
        if (cancelledIntentIds.current.delete(intent.id)) return null;
        void refreshCurrent(targetThreadId).catch(() => undefined);
        throw error;
      }
    });
  }, [currentIntent, queryClient, refreshCurrent, runAction, service, submitIntent, uploads]);

  const selectRecoveryFiles = useCallback(async (selectedFiles: readonly File[]) => {
    if (!currentIntent) throw new Error("There is no submission to recover");
    const slots = selectSubmissionIntentReselectionSlots(currentIntent);
    const matches = matchSubmissionIntentFiles(slots, selectedFiles);
    return runAction(currentIntent.projectId, async () => {
      try {
        const uploaded = await uploads.uploadFiles(
          currentIntent.projectId,
          matches.map(({ file, slot }) => ({
            file,
            submissionIntent: {
              submissionIntentId: currentIntent.id,
              attachmentPosition: slot.position,
              clientFingerprint: slot.clientFingerprint,
            },
          })),
        );
        pendingBatches.current.set(currentIntent.id, uploaded.batchId);
        const refreshed = await refreshCurrent(currentIntent.threadId);
        if (refreshed === undefined) {
          throw new Error("The recovered submission state changed while attachments were uploading");
        }
        if (!refreshed || refreshed.id !== currentIntent.id) {
          throw new Error("The recovered submission is no longer active");
        }
        const state = submissionIntentRecoveryState(refreshed);
        if (state !== "ready_to_submit" && !canReplaySubmissionIntentSubmit(refreshed)) {
          throw new Error("The recovered attachments are not ready to submit");
        }
        return submitIntent(refreshed);
      } catch (error) {
        if (cancelledIntentIds.current.delete(currentIntent.id)) return null;
        throw error;
      }
    }, currentIntent.id);
  }, [currentIntent, refreshCurrent, runAction, submitIntent, uploads]);

  const retryRecovery = useCallback(async () => {
    if (!currentIntent) throw new Error("There is no submission to retry");
    const existingAcceptance = acceptedSubmissions.get(currentIntent.id);
    if (existingAcceptance) return existingAcceptance;
    return runAction(
      currentIntent.projectId,
      () => submitIntent(currentIntent),
      currentIntent.id,
    );
  }, [acceptedSubmissions, currentIntent, runAction, submitIntent]);

  const cancelRecovery = useCallback(async () => {
    if (!currentIntent) throw new Error("There is no submission to cancel");
    if (currentIntent.status !== "pending") {
      throw new Error("This submission can no longer be cancelled");
    }
    if (cancellationActionsRef.current.has(currentIntent.id)) {
      throw new Error("Submission cancellation is already running");
    }
    const cancellationToken = Symbol(currentIntent.id);
    cancellationActionsRef.current.set(currentIntent.id, cancellationToken);
    setCancellationIntentIds((current) => new Set(current).add(currentIntent.id));
    const hadActiveUpload = actionsRef.current.get(currentIntent.projectId)?.intentId
      === currentIntent.id;
    try {
      await service.cancelSubmissionIntent(
        currentIntent.id,
        `"${currentIntent.revision}"`,
      );
      cancelledIntentIds.current.add(currentIntent.id);
      pendingBatches.current.delete(currentIntent.id);
      uploads.releaseProjectUploads(currentIntent.projectId);
      await replaceCurrentWorkbenchSubmissionIntent(
        queryClient,
        currentIntent.threadId,
        { item: null },
      );
      setActionStates((current) => removeActionStateForIntent(
        current,
        currentIntent.projectId,
        currentIntent.id,
      ));
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.currentSubmissionIntent(currentIntent.threadId),
      });
      if (!hadActiveUpload) cancelledIntentIds.current.delete(currentIntent.id);
    } finally {
      if (cancellationActionsRef.current.get(currentIntent.id) === cancellationToken) {
        cancellationActionsRef.current.delete(currentIntent.id);
        setCancellationIntentIds((current) => {
          if (!current.has(currentIntent.id)) return current;
          const next = new Set(current);
          next.delete(currentIntent.id);
          return next;
        });
      }
    }
  }, [currentIntent, queryClient, service, uploads]);

  const selectedActionState = actionStates.get(projectId) ?? null;
  useEffect(() => {
    if (
      !currentIntent
      || selectedActionState?.pending
      || actionsRef.current.has(currentIntent.projectId)
    ) return;
    const canSubmit = submissionIntentRecoveryState(currentIntent) === "ready_to_submit"
      || canReplaySubmissionIntentSubmit(currentIntent);
    const reusableSubmission = submissionRegistry.inFlight.has(currentIntent.id)
      || submissionRegistry.settled.has(currentIntent.id);
    if (
      !canSubmit
      || automaticReplayAttempts.has(currentIntent.id)
      || (
        submissionRegistry.networkSubmissionAttempts.has(currentIntent.id)
        && !reusableSubmission
      )
    ) return;
    rememberAutomaticReplayAttempt(automaticReplayAttempts, currentIntent.id);
    void runAction(
      currentIntent.projectId,
      () => submitIntent(currentIntent),
      currentIntent.id,
    ).catch(() => {
      void refreshCurrent(currentIntent.threadId).catch(() => undefined);
    });
  }, [
    automaticReplayAttempts,
    currentIntent,
    refreshCurrent,
    runAction,
    selectedActionState?.pending,
    submitIntent,
    submissionRegistry,
  ]);

  const scopedActionError = currentIntent && selectedActionState?.intentId === currentIntent.id
    ? selectedActionState.error
    : null;
  const cancellationPending = currentIntent
    ? cancellationIntentIds.has(currentIntent.id)
    : false;
  const recoveryActionPending = Boolean(
    currentIntent
    && selectedActionState?.pending
    && selectedActionState.intentId === currentIntent.id,
  );
  const submissionActionPending = recoveryActionPending || cancellationPending;
  const recovery = useMemo(() => projectSubmissionRecovery(
    currentIntent,
    submissionActionPending,
    scopedActionError,
  ), [currentIntent, scopedActionError, submissionActionPending]);

  return {
    actionError: currentIntent
      ? scopedActionError
      : selectedActionState?.error ?? null,
    actionPending: Boolean(selectedActionState?.pending) || cancellationPending,
    cancelRecovery,
    recovery,
    retryRecovery,
    selectRecoveryFiles,
    submitPrepared,
  };
}

export function resetWorkbenchSubmissionCoordinatorRegistryForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The SubmissionIntent registry may be reset only in tests");
  }
  submissionIntentRegistry = createSubmissionIntentRegistry();
}

function createSubmissionIntentRegistry(): SubmissionIntentRegistry {
  return {
    clientStates: new WeakMap(),
    inFlight: new Map(),
    networkSubmissionAttempts: new Set(),
    settled: new Map(),
  };
}

function submissionClientStateFor(
  registry: SubmissionIntentRegistry,
  queryClient: QueryClient,
): SubmissionIntentClientState {
  let state = registry.clientStates.get(queryClient);
  if (!state) {
    state = {
      acceptedSubmissions: new Map(),
      automaticReplayAttempts: new Set(),
    };
    registry.clientStates.set(queryClient, state);
  }
  return state;
}

function rememberSettledSubmission(
  registry: SubmissionIntentRegistry,
  expectedIntent: SubmissionIntent,
  receipt: SubmissionIntentReceipt,
): SubmissionIntentReceipt {
  const { intent, run } = receipt.value;
  if (
    intent.id !== expectedIntent.id
    || intent.projectId !== expectedIntent.projectId
    || intent.threadId !== expectedIntent.threadId
    || run.projectId !== intent.projectId
    || run.threadId !== intent.threadId
  ) {
    throw new Error("SubmissionIntent submit receipt identity does not match the submitted Intent");
  }
  rememberBounded(registry.settled, intent.id, receipt);
  return receipt;
}

function rememberAutomaticReplayAttempt(attempts: Set<string>, intentId: string): void {
  attempts.delete(intentId);
  attempts.add(intentId);
  while (attempts.size > MAX_REMEMBERED_SUBMISSIONS) {
    const oldest = attempts.values().next().value;
    if (oldest === undefined) return;
    attempts.delete(oldest);
  }
}

function rememberBounded<Value>(target: Map<string, Value>, key: string, value: Value): void {
  target.delete(key);
  target.set(key, value);
  while (target.size > MAX_REMEMBERED_SUBMISSIONS) {
    const oldest = target.keys().next().value;
    if (oldest === undefined) return;
    target.delete(oldest);
  }
}

function updateActionState(
  current: Map<string, WorkbenchSubmissionActionState>,
  projectId: string,
  token: symbol,
  update: (state: WorkbenchSubmissionActionState) => WorkbenchSubmissionActionState,
): Map<string, WorkbenchSubmissionActionState> {
  const state = current.get(projectId);
  if (!state || state.token !== token) return current;
  const next = new Map(current);
  next.set(projectId, update(state));
  return next;
}

function removeActionStateForIntent(
  current: Map<string, WorkbenchSubmissionActionState>,
  projectId: string,
  intentId: string,
): Map<string, WorkbenchSubmissionActionState> {
  if (current.get(projectId)?.intentId !== intentId) return current;
  const next = new Map(current);
  next.delete(projectId);
  return next;
}

function removeActionState(
  current: Map<string, WorkbenchSubmissionActionState>,
  projectId: string,
  token: symbol,
): Map<string, WorkbenchSubmissionActionState> {
  if (current.get(projectId)?.token !== token) return current;
  const next = new Map(current);
  next.delete(projectId);
  return next;
}

export function createWorkbenchSubmissionPlan(
  submission: WorkbenchPreparedSubmission,
  fingerprintFactory: () => string = () => `submission-file:${nanoid(24)}`,
): WorkbenchSubmissionPlan {
  const files = [...(submission.files ?? [])];
  const usedFingerprints = new Set<string>();
  const uploads = files.map((file, index) => {
    let clientFingerprint = fingerprintFactory();
    for (let attempt = 0; usedFingerprints.has(clientFingerprint); attempt += 1) {
      if (attempt >= 10) throw new Error("Unable to allocate a unique submission file slot");
      clientFingerprint = fingerprintFactory();
    }
    usedFingerprints.add(clientFingerprint);
    return {
      clientFingerprint,
      file,
      position: index,
    };
  });
  const request = createSubmissionIntentRequestSchema.parse({
    request: {
      ...submission.request,
      sourceIds: [...new Set(submission.request.sourceIds ?? [])],
    },
    attachments: uploads.map(({ clientFingerprint, file }) => ({
        kind: "upload" as const,
        clientFingerprint,
        fileName: file.name,
        declaredMediaType: normalizeDeclaredMediaType(file.type),
        byteSize: file.size,
        lastModified: file.lastModified,
      })),
  });
  return { request, uploads };
}

export function matchSubmissionIntentFiles(
  slots: ReturnType<typeof selectSubmissionIntentReselectionSlots>,
  selectedFiles: readonly File[],
) {
  if (selectedFiles.length !== slots.length) {
    throw new Error(`请选择全部 ${slots.length} 个原附件`);
  }
  const unmatched = [...selectedFiles];
  const matches = slots.map((slot) => {
    const index = unmatched.findIndex((file) => (
      file.name === slot.fileName
      && file.size === slot.byteSize
      && file.lastModified === slot.lastModified
      && normalizeDeclaredMediaType(file.type) === slot.declaredMediaType
    ));
    if (index < 0) throw new Error(`所选文件与原附件 ${slot.fileName} 不一致`);
    const [file] = unmatched.splice(index, 1);
    return { file: file!, slot };
  });
  if (unmatched.length > 0) throw new Error("所选文件包含不属于本次提交的附件");
  return matches;
}

function submissionUploadInputs(
  intent: SubmissionIntent,
  uploads: WorkbenchSubmissionPlan["uploads"],
): WorkbenchUploadInput[] {
  const slots = new Map(intent.attachments.flatMap((attachment) => (
    attachment.kind === "upload"
      ? [[attachment.clientFingerprint, attachment] as const]
      : []
  )));
  return uploads.map(({ clientFingerprint, file, position }) => {
    const slot = slots.get(clientFingerprint);
    if (!slot || slot.position !== position) {
      throw new Error("The server SubmissionIntent does not match the prepared upload slots");
    }
    return {
      file,
      submissionIntent: {
        submissionIntentId: intent.id,
        attachmentPosition: slot.position,
        clientFingerprint,
      },
    };
  });
}

function projectSubmissionRecovery(
  intent: SubmissionIntent | null,
  actionPending: boolean,
  actionError: unknown,
): WorkbenchSubmissionRecovery | null {
  if (!intent) return null;
  const state = submissionIntentRecoveryState(intent);
  const slots = selectSubmissionIntentReselectionSlots(intent);
  const terminalFileFailure = intent.attachments.some((attachment) => (
    attachment.fileStatus === "failed"
      || attachment.fileStatus === "quarantined"
      || attachment.fileStatus === "deleted"
  ));
  const error = actionError instanceof Error ? actionError.message : null;
  if (state === "failed" || (error && !actionPending)) {
    return {
      actionPending,
      cancellable: intent.status === "pending" && !actionPending,
      error,
      files: [],
      kind: "failed",
      message: intent.lastFailure?.message ?? "上次提交未完成",
      retryable: !terminalFileFailure
        && slots.length === 0
        && (intent.lastFailure?.retryable ?? Boolean(error)),
    };
  }
  if (state === "waiting_files" && !actionPending) {
    return {
      actionPending,
      cancellable: intent.status === "pending",
      error: null,
      files: slots.map((slot) => ({
        byteSize: slot.byteSize,
        fileName: slot.fileName,
        position: slot.position,
      })),
      kind: "waiting_files",
      message: `请重新选择 ${slots.length} 个原附件`,
      retryable: false,
    };
  }
  return {
    actionPending,
    cancellable: intent.status === "pending"
      && (state === "waiting_files" || state === "processing"),
    error: null,
    files: [],
    kind: "processing",
    message: intent.status === "submitting" || state === "ready_to_submit"
      ? "正在恢复提交"
      : "附件正在校验",
    retryable: false,
  };
}

function normalizeDeclaredMediaType(value: string): string {
  return value.trim().toLowerCase() || "application/octet-stream";
}
