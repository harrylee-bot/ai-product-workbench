"use client";

import type { SubmissionIntent } from "@workbench/workbench-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type Versioned,
} from "../../../transport/contracts";
import {
  useWorkbenchSubmissionIntentsApi,
  type CreateSubmissionIntentInput,
} from "../api-adapter";
import {
  DEFAULT_SUBMISSION_INTENT_POLL_INTERVAL_MS,
  needsSubmissionIntentPolling,
} from "../domain";
import { replaceCurrentWorkbenchSubmissionIntent } from "./current-intent-cache";

export * from "./coordinator";

export function useCurrentWorkbenchSubmissionIntent(
  threadId: string,
) {
  const service = useWorkbenchSubmissionIntentsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.currentSubmissionIntent(threadId),
    queryFn: ({ signal }) => service.getCurrentSubmissionIntent(threadId, signal),
    enabled: Boolean(threadId),
    refetchInterval: (query) => needsSubmissionIntentPolling(query.state.data)
      ? DEFAULT_SUBMISSION_INTENT_POLL_INTERVAL_MS
      : false,
  });
}

export function useWorkbenchSubmissionIntent(intentId: string) {
  const service = useWorkbenchSubmissionIntentsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.submissionIntent(intentId),
    queryFn: () => service.getSubmissionIntent(intentId),
    enabled: Boolean(intentId),
  });
}

export function useCreateWorkbenchSubmissionIntent(
  threadId: string,
) {
  const service = useWorkbenchSubmissionIntentsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.currentSubmissionIntent(threadId), "create"],
    mutationFn: ({ request, idempotencyKey }: {
      request: CreateSubmissionIntentInput;
      idempotencyKey?: string;
    }) => service.createSubmissionIntent(threadId, request, idempotencyKey),
    async onSuccess(result) {
      await replaceCurrentWorkbenchSubmissionIntent(
        queryClient,
        threadId,
        { item: result.value },
        result,
      );
    },
  });
}

export function useSubmitWorkbenchSubmissionIntent(
  projectId: string,
  threadId: string,
  intentId: string,
) {
  const service = useWorkbenchSubmissionIntentsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [
      ...workbenchQueryKeys.submissionIntent(intentId),
      projectId,
      threadId,
      "submit",
    ],
    mutationFn: () => service.submitSubmissionIntent(intentId),
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.submissionIntent(intentId),
        { value: result.value.intent, etag: result.etag },
      );
      await replaceCurrentWorkbenchSubmissionIntent(
        queryClient,
        threadId,
        { item: null },
      );
      queryClient.setQueryData(
        workbenchQueryKeys.run(result.value.run.id),
        result.value.run,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.currentSubmissionIntent(threadId),
        }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.runLists(projectId, threadId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.entryLists(projectId, threadId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.thread(projectId, threadId) }),
      ]);
    },
  });
}

export function useCancelWorkbenchSubmissionIntent(
  threadId: string,
  intentId: string,
) {
  const service = useWorkbenchSubmissionIntentsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [
      ...workbenchQueryKeys.submissionIntent(intentId),
      threadId,
      "cancel",
    ],
    mutationFn: async ({ ifMatch }: { ifMatch?: string } = {}) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<SubmissionIntent>>(
          workbenchQueryKeys.submissionIntent(intentId),
        )?.etag;
      if (!etag) {
        throw new WorkbenchVersionRequiredError("submission intent", intentId);
      }
      await service.cancelSubmissionIntent(intentId, etag);
    },
    async onSuccess() {
      await replaceCurrentWorkbenchSubmissionIntent(
        queryClient,
        threadId,
        { item: null },
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.currentSubmissionIntent(threadId),
        }),
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.submissionIntent(intentId),
        }),
      ]);
    },
  });
}
