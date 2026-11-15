"use client";

import type {
  CreateImportSourceRequest,
  ImportSource,
  ImportSourceList,
} from "@workbench/workbench-contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type Versioned,
} from "../../../transport/contracts";
import {
  useWorkbenchImportSourcesApi,
  type WorkbenchImportSourcesApi,
} from "../api-adapter";
import {
  importSourceListRefetchInterval,
  importSourceRefetchInterval,
  type ImportSourceListOptions,
} from "../domain";

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
  const service = useWorkbenchImportSourcesApi();
  return useQuery({
    queryKey: workbenchQueryKeys.importSourceList(projectId, options),
    queryFn: () => {
      return service.listImportSources(projectId, options);
    },
    enabled: Boolean(projectId && service),
    refetchInterval: (query) => importSourceListRefetchInterval(query.state.data?.items),
  });
}

export function useWorkbenchImportSource(projectId: string, sourceId: string) {
  const service = useWorkbenchImportSourcesApi();
  return useQuery({
    queryKey: workbenchQueryKeys.importSource(projectId, sourceId),
    queryFn: () => {
      return service.getImportSource(sourceId);
    },
    enabled: Boolean(projectId && sourceId && service),
    refetchInterval: (query) => importSourceRefetchInterval(query.state.data?.value),
  });
}

export function useCreateWorkbenchImportSource(projectId: string) {
  const service = useWorkbenchImportSourcesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.importSources(projectId), "create"],
    mutationFn: ({ request, idempotencyKey }: {
      request: CreateImportSourceRequest;
      idempotencyKey?: string;
    }) => {
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
  });
}

export function useDeleteWorkbenchImportSource(projectId: string) {
  const service = useWorkbenchImportSourcesApi();
  const queryClient = useQueryClient();
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
  });
}
