"use client";

import type {
  CreateDesignSystemRequest,
  ImportDesignSystemRequest,
} from "@workbench/workbench-contracts";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  useWorkbenchDesignSystemsApi,
  type WorkbenchDesignSystemsApi,
} from "../api-adapter";
import type { DesignSystemCatalogOptions } from "../domain";

export type WorkbenchDesignSystemOperations = Pick<
  WorkbenchDesignSystemsApi,
  "createDesignSystem" | "importDesignSystem"
>;

export function useWorkbenchDesignSystemOperations(): WorkbenchDesignSystemOperations {
  return useWorkbenchDesignSystemsApi();
}

export function useInfiniteWorkbenchDesignSystemCatalog(
  workspaceId: string,
  options: Omit<DesignSystemCatalogOptions, "cursor"> = {},
) {
  const api = useWorkbenchDesignSystemsApi();
  return useInfiniteQuery({
    queryKey: workbenchQueryKeys.designSystemInfiniteCatalog(workspaceId, options),
    queryFn: ({ pageParam }) => api.listDesignSystemCatalog(workspaceId, {
      ...options,
      cursor: pageParam,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(workspaceId),
  });
}

export function useCreateWorkbenchDesignSystem(projectId: string, workspaceId: string) {
  const api = useWorkbenchDesignSystemsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      request,
      idempotencyKey,
    }: {
      request: CreateDesignSystemRequest;
      idempotencyKey?: string;
    }) => api.createDesignSystem(projectId, request, idempotencyKey),
    async onSuccess() {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.artifactLists(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.designSystemCatalogs(workspaceId) }),
      ]);
    },
  });
}

export function useImportWorkbenchDesignSystem(projectId: string, workspaceId: string) {
  const api = useWorkbenchDesignSystemsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      request,
      idempotencyKey,
    }: {
      request: ImportDesignSystemRequest;
      idempotencyKey?: string;
    }) => api.importDesignSystem(projectId, request, idempotencyKey),
    async onSuccess() {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.artifactLists(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.designSystemCatalogs(workspaceId) }),
      ]);
    },
  });
}
