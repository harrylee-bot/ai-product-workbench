"use client";

import type {
  Board,
  CreateProjectReleaseRequest,
} from "@workbench/workbench-contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type CursorPageOptions,
  type Versioned,
} from "../../../transport/contracts";
import { useWorkbenchReleasesApi } from "../api-adapter";

export function useWorkbenchReleases(
  projectId: string,
  options: CursorPageOptions = {},
) {
  const service = useWorkbenchReleasesApi();
  return useQuery({
    queryKey: workbenchQueryKeys.releaseList(projectId, options),
    queryFn: () => service.listProjectReleases(projectId, options),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  });
}

export function useWorkbenchRelease(projectId: string, releaseId: string) {
  const service = useWorkbenchReleasesApi();
  return useQuery({
    queryKey: workbenchQueryKeys.release(projectId, releaseId),
    queryFn: () => service.getProjectRelease(releaseId),
    enabled: Boolean(projectId && releaseId),
  });
}

export function useCreateWorkbenchRelease(projectId: string) {
  const service = useWorkbenchReleasesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.releases(projectId), "create"],
    mutationFn: ({ request, ifMatch, idempotencyKey }: {
      request: CreateProjectReleaseRequest;
      ifMatch?: string;
      idempotencyKey?: string;
    }) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<Board>>(
          workbenchQueryKeys.board(projectId),
        )?.etag;
      if (!etag) throw new WorkbenchVersionRequiredError("board", projectId);
      return service.createProjectRelease(projectId, request, etag, idempotencyKey);
    },
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.release(projectId, result.value.id),
        result,
      );
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.releaseLists(projectId),
      });
    },
  });
}
