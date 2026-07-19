"use client";

import type {
  CreateImportSourceRequest,
  ImportSource,
  ImportSourceList,
} from "@workbench/workbench-contracts";
import {
  QueryClient,
  QueryClientContext,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useContext } from "react";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type Versioned,
} from "../../../transport/contracts";
import {
  useOptionalWorkbenchImportSourcesApi,
  useWorkbenchImportSourcesApi,
  type WorkbenchImportSourcesApi,
} from "../api-adapter";
import {
  importSourceListRefetchInterval,
  importSourceRefetchInterval,
  type ImportSourceListOptions,
} from "../domain";

const fallbackImportSourceQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

export type WorkbenchImportSourcesOperations = Pick<
  WorkbenchImportSourcesApi,
  "createImportSource"
>;

export function useWorkbenchImportSourcesOperations(): WorkbenchImportSourcesOperations {
  return useWorkbenchImportSourcesApi();
}

export function useWorkbenchImportSources(
  projectId: string,
  options: ImportSourceListOptions = {},
) {
  const service = useOptionalWorkbenchImportSourcesApi();
  const queryClient = useContext(QueryClientContext) ?? fallbackImportSourceQueryClient;
  return useQuery({
    queryKey: workbenchQueryKeys.importSourceList(projectId, options),
    queryFn: () => {
      if (!service) throw new Error("Workbench transport is not available");
      return service.listImportSources(projectId, options);
    },
    enabled: Boolean(projectId && service),
    refetchInterval: (query) => importSourceListRefetchInterval(query.state.data?.items),
  }, queryClient);
}

export function useWorkbenchImportSource(projectId: string, sourceId: string) {
  const service = useOptionalWorkbenchImportSourcesApi();
  const queryClient = useContext(QueryClientContext) ?? fallbackImportSourceQueryClient;
  return useQuery({
    queryKey: workbenchQueryKeys.importSource(projectId, sourceId),
    queryFn: () => {
      if (!service) throw new Error("Workbench transport is not available");
      return service.getImportSource(sourceId);
    },
    enabled: Boolean(projectId && sourceId && service),
    refetchInterval: (query) => importSourceRefetchInterval(query.state.data?.value),
  }, queryClient);
}

export function useCreateWorkbenchImportSource(projectId: string) {
  const service = useOptionalWorkbenchImportSourcesApi();
  const queryClient = useContext(QueryClientContext) ?? fallbackImportSourceQueryClient;
  return useMutation({
    mutationKey: [...workbenchQueryKeys.importSources(projectId), "create"],
    mutationFn: ({ request, idempotencyKey }: {
      request: CreateImportSourceRequest;
      idempotencyKey?: string;
    }) => {
      if (!service) throw new Error("Workbench transport is not available");
      return service.createImportSource(projectId, request, idempotencyKey);
    },
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.importSource(projectId, result.value.id),
        result,
      );
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.importSources(projectId),
      });
    },
  }, queryClient);
}

export function useDeleteWorkbenchImportSource(projectId: string) {
  const service = useOptionalWorkbenchImportSourcesApi();
  const queryClient = useContext(QueryClientContext) ?? fallbackImportSourceQueryClient;
  return useMutation({
    mutationKey: [...workbenchQueryKeys.importSources(projectId), "delete"],
    mutationFn: async ({ sourceId, ifMatch }: { sourceId: string; ifMatch?: string }) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<ImportSource>>(
          workbenchQueryKeys.importSource(projectId, sourceId),
        )?.etag
        ?? (() => {
          const source = queryClient.getQueryData<ImportSourceList>(
            workbenchQueryKeys.importSourceList(projectId),
          )?.items.find((item) => item.id === sourceId);
          return source ? `"${source.revision}"` : undefined;
        })();
      if (!etag) throw new WorkbenchVersionRequiredError("import source", sourceId);
      if (!service) throw new Error("Workbench transport is not available");
      await service.deleteImportSource(sourceId, etag);
      return sourceId;
    },
    async onSuccess(sourceId) {
      queryClient.removeQueries({
        queryKey: workbenchQueryKeys.importSource(projectId, sourceId),
      });
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.importSources(projectId),
      });
    },
  }, queryClient);
}
