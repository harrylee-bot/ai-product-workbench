"use client";

import type {
  Run,
  SubmitApprovalRequest,
} from "@workbench/workbench-contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import type { CursorPageOptions } from "../../../transport/contracts";
import { useWorkbenchRunsApi } from "../api-adapter";

export function useWorkbenchRuns(
  projectId: string,
  threadId: string,
  options: CursorPageOptions = {},
) {
  const service = useWorkbenchRunsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.runList(projectId, threadId, options),
    queryFn: () => service.listRuns(threadId, options),
    enabled: Boolean(projectId && threadId),
    placeholderData: keepPreviousData,
  });
}

export type WorkbenchRunQueryOptions = {
  enabled?: boolean;
  refetchIntervalMs?: number | false;
};

export function useWorkbenchRun(
  runId: string,
  {
    enabled = true,
    refetchIntervalMs = false,
  }: WorkbenchRunQueryOptions = {},
) {
  const service = useWorkbenchRunsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.run(runId),
    queryFn: () => service.getRun(runId),
    enabled: Boolean(runId) && enabled,
    refetchInterval: (query) => {
      if (refetchIntervalMs === false || isTerminalStatus(query.state.data?.status)) return false;
      return refetchIntervalMs;
    },
  });
}

export function useCancelWorkbenchRun(projectId: string, threadId: string, runId: string) {
  const service = useWorkbenchRunsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.run(runId), projectId, threadId, "cancel"],
    mutationFn: ({ idempotencyKey }: { idempotencyKey?: string } = {}) =>
      service.cancelRun(runId, idempotencyKey),
    async onSuccess(run) {
      queryClient.setQueryData(workbenchQueryKeys.run(runId), run);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.runLists(projectId, threadId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.entryLists(projectId, threadId) }),
      ]);
    },
  });
}

export function useRetryWorkbenchRun(projectId: string, threadId: string, runId: string) {
  const service = useWorkbenchRunsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.run(runId), projectId, threadId, "retry"],
    mutationFn: ({ idempotencyKey }: { idempotencyKey?: string } = {}) =>
      service.retryRun(runId, idempotencyKey),
    async onSuccess(run) {
      queryClient.setQueryData(workbenchQueryKeys.run(run.id), run);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.runLists(projectId, threadId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.entryLists(projectId, threadId) }),
      ]);
    },
  });
}

export function useWorkbenchRunApprovals(runId: string) {
  const service = useWorkbenchRunsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.approvals(runId),
    queryFn: () => service.listRunApprovals(runId),
    enabled: Boolean(runId),
  });
}

export function useWorkbenchRunApproval(runId: string, approvalId: string) {
  const service = useWorkbenchRunsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.approval(runId, approvalId),
    queryFn: () => service.getRunApproval(runId, approvalId),
    enabled: Boolean(runId && approvalId),
  });
}

export function useSubmitWorkbenchRunApproval({
  projectId,
  threadId,
  runId,
  approvalId,
}: {
  projectId: string;
  threadId: string;
  runId: string;
  approvalId: string;
}) {
  const service = useWorkbenchRunsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [
      ...workbenchQueryKeys.approval(runId, approvalId),
      projectId,
      threadId,
      "submit",
    ],
    mutationFn: ({ request, idempotencyKey }: {
      request: SubmitApprovalRequest;
      idempotencyKey?: string;
    }) => service.submitRunApproval(runId, approvalId, request, idempotencyKey),
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.approval(runId, approvalId),
        { value: result.value.approval, etag: result.etag },
      );
      queryClient.setQueryData<Run>(workbenchQueryKeys.run(runId), result.value.run);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.approvals(runId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.runLists(projectId, threadId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.entryLists(projectId, threadId) }),
      ]);
    },
  });
}

function isTerminalStatus(status: Run["status"] | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
