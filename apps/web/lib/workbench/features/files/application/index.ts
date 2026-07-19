"use client";

import type {
  CreateFileUploadRequest,
  FileAsset,
} from "@workbench/workbench-contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type Versioned,
} from "../../../transport/contracts";
import { useWorkbenchFilesApi } from "../api-adapter";
import {
  DEFAULT_FILE_POLL_INTERVAL_MS,
  workbenchFileRefetchInterval,
  type FileListOptions,
  type WorkbenchFilePollingOptions,
} from "../domain";
import type { WorkbenchFileTransferService } from "../../../files/uppy-multipart";

export {
  createWorkbenchMultipartUpload,
  type WorkbenchFileTransferService,
  type WorkbenchMultipartUpload,
  type WorkbenchUploadSnapshot,
} from "../../../files/uppy-multipart";
export {
  useWorkbenchUploadRegistry,
  type WorkbenchUploadBatchResult,
  type WorkbenchUploadInput,
  type WorkbenchUploadItemViewModel,
} from "../../../files/upload-registry";
export {
  clearWorkbenchUploadCheckpoints,
  createWorkbenchUploadCheckpointStore,
  getDefaultWorkbenchUploadCheckpointStore,
  listWorkbenchUploadCheckpoints,
  type WorkbenchIndexedDbCheckpointStoreOptions,
  type WorkbenchUploadCheckpointListingStore,
} from "../../../files/upload-checkpoint-store";

export function useWorkbenchFileTransferService(): WorkbenchFileTransferService {
  return useWorkbenchFilesApi();
}

export function useWorkbenchFiles(projectId: string, options: FileListOptions = {}) {
  const api = useWorkbenchFilesApi();
  return useQuery({
    queryKey: workbenchQueryKeys.fileList(projectId, options),
    queryFn: () => api.listFiles(projectId, options),
    enabled: Boolean(projectId),
    placeholderData: keepPreviousData,
  });
}

export function useWorkbenchFile(
  projectId: string,
  fileId: string,
  polling: WorkbenchFilePollingOptions = {},
) {
  const api = useWorkbenchFilesApi();
  return useQuery({
    queryKey: workbenchQueryKeys.file(projectId, fileId),
    queryFn: () => api.getFile(fileId),
    enabled: Boolean(projectId && fileId),
    refetchInterval: (query) => workbenchFileRefetchInterval(
      query.state.data?.value,
      polling,
    ),
  });
}

export function useWorkbenchFileUpload(projectId: string, uploadSessionId: string) {
  const api = useWorkbenchFilesApi();
  return useQuery({
    queryKey: workbenchQueryKeys.fileUpload(projectId, uploadSessionId),
    queryFn: () => api.getFileUpload(uploadSessionId),
    enabled: Boolean(projectId && uploadSessionId),
    refetchInterval: (query) => {
      const status = query.state.data?.value.status;
      return status === "initiating" || status === "completing" || status === "aborting"
        ? DEFAULT_FILE_POLL_INTERVAL_MS
        : false;
    },
  });
}

export function useCreateWorkbenchFileUpload(projectId: string) {
  const api = useWorkbenchFilesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ request, idempotencyKey }: {
      request: CreateFileUploadRequest;
      idempotencyKey?: string;
    }) => api.createFileUpload(projectId, request, idempotencyKey),
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.fileUpload(projectId, result.value.upload.id),
        { value: result.value.upload, etag: result.etag },
      );
      await queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.fileLists(projectId) });
    },
  });
}

export function useCreateWorkbenchFileExtraction(projectId: string, fileId: string) {
  const api = useWorkbenchFilesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ifMatch, idempotencyKey }: {
      ifMatch?: string;
      idempotencyKey?: string;
    } = {}) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<FileAsset>>(
          workbenchQueryKeys.file(projectId, fileId),
        )?.etag;
      if (!etag) throw new WorkbenchVersionRequiredError("file", fileId);
      return api.createFileExtraction(fileId, etag, idempotencyKey);
    },
    async onSuccess() {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.file(projectId, fileId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.fileLists(projectId) }),
      ]);
    },
  });
}

export function useDeleteWorkbenchFile(projectId: string, fileId: string) {
  const api = useWorkbenchFilesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ifMatch }: { ifMatch?: string } = {}) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<FileAsset>>(
          workbenchQueryKeys.file(projectId, fileId),
        )?.etag;
      if (!etag) throw new WorkbenchVersionRequiredError("file", fileId);
      await api.deleteFile(fileId, etag);
    },
    async onSuccess() {
      queryClient.removeQueries({ queryKey: workbenchQueryKeys.file(projectId, fileId) });
      await queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.fileLists(projectId) });
    },
  });
}

export function useAbortWorkbenchFileUpload(projectId: string, uploadSessionId: string) {
  const api = useWorkbenchFilesApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ifMatch }: { ifMatch?: string } = {}) => {
      const etag = ifMatch
        ?? queryClient.getQueryData<Versioned<Awaited<ReturnType<typeof api.getFileUpload>>["value"]>>(
          workbenchQueryKeys.fileUpload(projectId, uploadSessionId),
        )?.etag;
      if (!etag) throw new WorkbenchVersionRequiredError("file upload", uploadSessionId);
      await api.abortFileUpload(uploadSessionId, etag);
    },
    async onSuccess() {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.fileUpload(projectId, uploadSessionId),
        }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.fileLists(projectId) }),
      ]);
    },
  });
}
