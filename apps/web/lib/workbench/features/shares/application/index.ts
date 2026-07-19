"use client";

import type {
  RotateShareGrantRequest,
  ShareGrant,
} from "@workbench/workbench-contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type CursorPageOptions,
  type Versioned,
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

export function useWorkbenchShareGrant(projectId: string, shareId: string) {
  const service = useWorkbenchSharesApi();
  return useQuery({
    queryKey: workbenchQueryKeys.share(projectId, shareId),
    queryFn: () => service.getShareGrant(shareId),
    enabled: Boolean(projectId && shareId),
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

export function useRevokeWorkbenchShareGrant(projectId: string, shareId: string) {
  const service = useWorkbenchSharesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.share(projectId, shareId), "revoke"],
    mutationFn: ({ ifMatch }: { ifMatch?: string } = {}) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<ShareGrant>>(
          workbenchQueryKeys.share(projectId, shareId),
        )?.etag;
      if (!etag) throw new WorkbenchVersionRequiredError("share grant", shareId);
      return service.revokeShareGrant(shareId, etag);
    },
    async onSuccess(result) {
      queryClient.setQueryData(workbenchQueryKeys.share(projectId, shareId), result);
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.shareLists(projectId),
      });
    },
  });
}
