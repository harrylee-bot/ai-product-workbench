"use client";

import type {
  CreateThreadRequest,
  Thread,
  UpdateThreadRequest,
} from "@workbench/workbench-contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type CursorPageOptions,
  type Versioned,
} from "../../../transport/contracts";
import { useWorkbenchThreadsApi } from "../api-adapter";
import type { ThreadEntryPageOptions } from "../domain";

export function useWorkbenchThreads(projectId: string, options: CursorPageOptions = {}) {
  const api = useWorkbenchThreadsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.threadList(projectId, options),
    queryFn: () => api.listThreads(projectId, options),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  });
}

export function useCreateWorkbenchThread(projectId: string) {
  const api = useWorkbenchThreadsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ request, idempotencyKey }: {
      request: CreateThreadRequest;
      idempotencyKey?: string;
    }) => api.createThread(projectId, request, idempotencyKey),
    async onSuccess(result) {
      queryClient.setQueryData(workbenchQueryKeys.thread(projectId, result.value.id), result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.threadLists(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstrap(projectId) }),
      ]);
    },
  });
}

export function useWorkbenchThread(projectId: string, threadId: string) {
  const api = useWorkbenchThreadsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.thread(projectId, threadId),
    queryFn: () => api.getThread(threadId),
    enabled: Boolean(projectId && threadId),
  });
}

export function useUpdateWorkbenchThread(projectId: string, threadId: string) {
  const api = useWorkbenchThreadsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ request, ifMatch }: { request: UpdateThreadRequest; ifMatch?: string }) => {
      const etag = ifMatch ?? cachedThreadEtag(queryClient, projectId, threadId);
      if (!etag) throw new WorkbenchVersionRequiredError("thread", threadId);
      return api.updateThread(threadId, request, etag);
    },
    async onSuccess(result) {
      queryClient.setQueryData(workbenchQueryKeys.thread(projectId, threadId), result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.threadLists(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstrap(projectId) }),
      ]);
    },
  });
}

export function useArchiveWorkbenchThread(projectId: string, threadId: string) {
  const api = useWorkbenchThreadsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ifMatch }: { ifMatch?: string } = {}) => {
      const etag = ifMatch ?? cachedThreadEtag(queryClient, projectId, threadId);
      if (!etag) throw new WorkbenchVersionRequiredError("thread", threadId);
      await api.archiveThread(threadId, etag);
    },
    async onSuccess() {
      queryClient.removeQueries({ queryKey: workbenchQueryKeys.thread(projectId, threadId) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.threadLists(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstrap(projectId) }),
      ]);
    },
  });
}

export function useWorkbenchThreadEntries(
  projectId: string,
  threadId: string,
  options: ThreadEntryPageOptions = {},
) {
  const api = useWorkbenchThreadsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.entries(projectId, threadId, options),
    queryFn: () => api.listThreadEntries(threadId, options),
    enabled: Boolean(projectId && threadId),
    placeholderData: keepPreviousData,
  });
}

function cachedThreadEtag(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  threadId: string,
): string | undefined {
  return queryClient.getQueryData<Versioned<Thread>>(
    workbenchQueryKeys.thread(projectId, threadId),
  )?.etag;
}
