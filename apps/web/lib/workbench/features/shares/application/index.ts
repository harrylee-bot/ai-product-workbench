"use client";

import type { RotateShareGrantRequest } from "@workbench/workbench-contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  type CursorPageOptions,
} from "../../../transport/contracts";
import { useWorkbenchSharesApi } from "../api-adapter";

export function useWorkbenchShareGrants(
  projectId: string,
  options: CursorPageOptions = {},
) {
  const service = useWorkbenchSharesApi();
  return useQuery({
    queryKey: workbenchQueryKeys.shareList(projectId, options),
    queryFn: () => service.listShareGrants(projectId, options),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  });
}

export function useRotateWorkbenchShareGrant(projectId: string) {
  const service = useWorkbenchSharesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.shares(projectId), "rotate"],
    mutationFn: ({ request, idempotencyKey }: {
      request: RotateShareGrantRequest;
      idempotencyKey?: string;
    }) => service.rotateShareGrant(projectId, request, idempotencyKey),
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.share(projectId, result.value.share.id),
        { value: result.value.share, etag: result.etag },
      );
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.shareLists(projectId),
      });
    },
  });
}

export function useRevokeWorkbenchProjectShareGrants(projectId: string) {
  const service = useWorkbenchSharesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.shares(projectId), "revoke-all"],
    mutationFn: () => service.revokeProjectShareGrants(projectId),
    async onSuccess() {
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.shares(projectId),
      });
    },
  });
}
