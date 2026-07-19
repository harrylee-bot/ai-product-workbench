"use client";

import type {
  CreateExportJobRequest,
  ExportJob,
  ProjectPreview,
} from "@workbench/workbench-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type CursorPageOptions,
  type Versioned,
} from "../../../transport/contracts";
import {
  useWorkbenchExportsApi,
  type WorkbenchExportsApi,
} from "../api-adapter";
import { needsExportPolling } from "../domain";

const DEFAULT_EXPORT_POLL_INTERVAL_MS = 1_000;

export type WorkbenchExportOperations = Pick<
  WorkbenchExportsApi,
  | "cancelExternalExportDelivery"
  | "confirmExternalExportDelivery"
  | "createExternalExportDelivery"
  | "createProjectPreview"
  | "createProjectPreviewToken"
  | "getExportContent"
  | "getExportJob"
  | "getExternalExportDelivery"
  | "listExternalExportDeliveries"
  | "getProjectPreview"
  | "retryExternalExportDelivery"
>;

export function useWorkbenchExportOperations(): WorkbenchExportOperations {
  return useWorkbenchExportsApi();
}

export function useWorkbenchExportCapabilities() {
  const api = useWorkbenchExportsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.exportCapabilities(),
    queryFn: () => api.getExportCapabilities(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useWorkbenchExportJobs(
  projectId: string,
  options: CursorPageOptions = {},
) {
  const api = useWorkbenchExportsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.exportJobList(projectId, options),
    queryFn: () => api.listExportJobs(projectId, options),
    enabled: Boolean(projectId),
  });
}

export function useWorkbenchExportJob(projectId: string, exportId: string) {
  const api = useWorkbenchExportsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.exportJob(projectId, exportId),
    queryFn: () => api.getExportJob(exportId),
    enabled: Boolean(projectId && exportId),
    refetchInterval: (query) => needsExportPolling(query.state.data?.value)
      ? DEFAULT_EXPORT_POLL_INTERVAL_MS
      : false,
  });
}

export function useCreateWorkbenchExportJob(projectId: string) {
  const api = useWorkbenchExportsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.exportJobs(projectId), "create"],
    mutationFn: ({ request, idempotencyKey }: {
      request: CreateExportJobRequest;
      idempotencyKey?: string;
    }) => api.createExportJob(projectId, request, idempotencyKey),
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.exportJob(projectId, result.value.id),
        result,
      );
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.exportJobLists(projectId),
      });
    },
  });
}

export function useCancelWorkbenchExportJob(projectId: string, exportId: string) {
  const api = useWorkbenchExportsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.exportJob(projectId, exportId), "cancel"],
    mutationFn: ({ ifMatch }: { ifMatch?: string } = {}) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<ExportJob>>(
          workbenchQueryKeys.exportJob(projectId, exportId),
        )?.etag;
      if (!etag) throw new WorkbenchVersionRequiredError("export job", exportId);
      return api.cancelExportJob(exportId, etag);
    },
    async onSuccess(result) {
      queryClient.setQueryData(workbenchQueryKeys.exportJob(projectId, exportId), result);
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.exportJobLists(projectId),
      });
    },
  });
}

export function useCreateWorkbenchExportPreviewToken(exportId: string) {
  const api = useWorkbenchExportsApi();
  return useMutation({
    mutationFn: () => api.createExportPreviewToken(exportId),
  });
}

export function useCreateWorkbenchProjectPreview(projectId: string) {
  const api = useWorkbenchExportsApi();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.projectPreviews(projectId), "create"],
    mutationFn: ({ boardId, boardRevision, selection }: Pick<
      ProjectPreview,
      "boardId" | "boardRevision" | "selection"
    >) => (
      api.createProjectPreview(projectId, { boardId, boardRevision, selection })
    ),
  });
}

export function useWorkbenchProjectPreview(previewId: string) {
  const api = useWorkbenchExportsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.projectPreview(previewId),
    queryFn: () => api.getProjectPreview(previewId),
    enabled: Boolean(previewId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? DEFAULT_EXPORT_POLL_INTERVAL_MS : false;
    },
  });
}

export function useCreateWorkbenchProjectPreviewToken(previewId: string) {
  const api = useWorkbenchExportsApi();
  return useMutation({
    mutationFn: () => api.createProjectPreviewToken(previewId),
  });
}

export function useWorkbenchExportContent(projectId: string, exportId: string) {
  const api = useWorkbenchExportsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.exportContent(projectId, exportId),
    queryFn: () => api.getExportContent(exportId),
    enabled: Boolean(projectId && exportId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
