"use client";

import type {
  ApprovalDecision,
  JsonValue,
  Run,
  RunApproval,
  SubmitApprovalRequest,
} from "@workbench/workbench-contracts";
import { useCallback, useEffect } from "react";

import {
  useCancelWorkbenchRun,
  useRetryWorkbenchRun,
  useSubmitWorkbenchRunApproval,
  useWorkbenchRunApprovals,
} from "./runs";

export function useWorkbenchRunActions(
  run: Run | null,
  onRetried?: (run: Run) => void,
) {
  const projectId = run?.projectId ?? "";
  const threadId = run?.threadId ?? "";
  const runId = run?.id ?? "";
  const approvalsQuery = useWorkbenchRunApprovals(runId);
  const pendingApproval = firstPendingApproval(approvalsQuery.data?.items);
  const approvalId = pendingApproval?.id ?? "";
  const cancelMutation = useCancelWorkbenchRun(projectId, threadId, runId);
  const retryMutation = useRetryWorkbenchRun(projectId, threadId, runId);
  const submitMutation = useSubmitWorkbenchRunApproval({
    projectId,
    threadId,
    runId,
    approvalId,
  });
  const cancelReset = cancelMutation.reset;
  const submitReset = submitMutation.reset;
  const retryReset = retryMutation.reset;
  const refetchApprovals = approvalsQuery.refetch;

  useEffect(() => {
    cancelReset();
    retryReset();
    submitReset();
  }, [approvalId, cancelReset, retryReset, runId, submitReset]);

  const cancel = useCallback(async () => {
    if (!run || !isCancellableRun(run)) {
      throw new Error("The current Run cannot be cancelled");
    }
    cancelMutation.reset();
    submitMutation.reset();
    return cancelMutation.mutateAsync({});
  }, [cancelMutation, run, submitMutation]);

  const submitApproval = useCallback(async (
    decision: ApprovalDecision,
    value?: JsonValue,
  ) => {
    if (!run || !pendingApproval) {
      throw new Error("The current Run has no pending approval");
    }
    const request: SubmitApprovalRequest = value === undefined
      ? { decision }
      : { decision, value };
    cancelMutation.reset();
    submitMutation.reset();
    return submitMutation.mutateAsync({ request });
  }, [cancelMutation, pendingApproval, run, submitMutation]);

  const retry = useCallback(async () => {
    if (!run || !isRetryableRun(run)) {
      throw new Error("The current Run cannot be retried");
    }
    cancelMutation.reset();
    retryMutation.reset();
    submitMutation.reset();
    const nextRun = await retryMutation.mutateAsync({});
    onRetried?.(nextRun);
    return nextRun;
  }, [cancelMutation, onRetried, retryMutation, run, submitMutation]);

  const busy = cancelMutation.isPending || retryMutation.isPending || submitMutation.isPending;
  const retryApprovals = useCallback(
    () => refetchApprovals({ throwOnError: true }),
    [refetchApprovals],
  );

  return {
    approvalsError: approvalsQuery.error,
    approvalsPending: approvalsQuery.isPending,
    busy,
    canCancel: Boolean(run && isCancellableRun(run) && !busy),
    canRetry: Boolean(run && isRetryableRun(run) && !busy),
    cancel,
    error: cancelMutation.error ?? retryMutation.error ?? submitMutation.error,
    pendingApproval,
    retry,
    retryApprovals,
    submitApproval,
  };
}

export function firstPendingApproval(
  approvals: readonly RunApproval[] | undefined,
): RunApproval | null {
  return approvals?.find((approval) => approval.status === "pending") ?? null;
}

export function isCancellableRun(run: Pick<Run, "status">): boolean {
  return run.status === "queued"
    || run.status === "running"
    || run.status === "waiting_input";
}

export function isRetryableRun(run: Pick<Run, "status" | "failure">): boolean {
  return run.status === "failed" && run.failure?.retryable === true;
}
