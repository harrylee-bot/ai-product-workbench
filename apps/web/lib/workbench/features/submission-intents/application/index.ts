"use client";

import { useQuery } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import { useWorkbenchSubmissionIntentsApi } from "../api-adapter";
import {
  DEFAULT_SUBMISSION_INTENT_POLL_INTERVAL_MS,
  needsSubmissionIntentPolling,
} from "../domain";

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
