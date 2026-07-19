"use client";

import {
  completeFileUploadRequestSchema,
  completeFileUploadResponseSchema,
  createFileUploadRequestSchema,
  createFileUploadResponseSchema,
  fileAssetSchema,
  fileExtractionSchema,
  fileListSchema,
  fileUploadSessionSchema,
  listUploadPartsResponseSchema,
  signUploadPartRequestSchema,
  signUploadPartResponseSchema,
  type CompleteFileUploadRequest,
  type CompleteFileUploadResponse,
  type CreateFileUploadRequest,
  type CreateFileUploadResponse,
  type FileAsset,
  type FileExtraction,
  type FileList,
  type FileUploadSession,
  type ListUploadPartsResponse,
  type SignUploadPartRequest,
  type SignUploadPartResponse,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  normalizeEtag,
  normalizeIdempotencyKey,
  parseContract,
  versioned,
  type Versioned,
} from "../../../transport/contracts";
import type { FileListOptions } from "../domain";

export class WorkbenchFilesApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listFiles(projectId: string, options: FileListOptions = {}): Promise<FileList> {
    const result = await this.api.GET("/projects/{projectId}/files", {
      params: { path: { projectId }, query: options },
    });
    return parseContract(fileListSchema, result.data, "list files");
  }

  async createFileUpload(
    projectId: string,
    request: CreateFileUploadRequest,
    idempotencyKey = createIdempotencyKey("upload"),
  ): Promise<Versioned<CreateFileUploadResponse>> {
    const result = await this.api.POST("/projects/{projectId}/file-upload-sessions", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: createFileUploadRequestSchema.parse(request),
    });
    return versioned(
      createFileUploadResponseSchema,
      result.data,
      result.response,
      "create file upload",
    );
  }

  async getFile(fileId: string): Promise<Versioned<FileAsset>> {
    const result = await this.api.GET("/files/{fileId}", {
      params: { path: { fileId } },
    });
    return versioned(fileAssetSchema, result.data, result.response, "get file");
  }

  async deleteFile(fileId: string, ifMatch: string): Promise<void> {
    await this.api.DELETE("/files/{fileId}", {
      params: {
        path: { fileId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
    });
  }

  async createFileExtraction(
    fileId: string,
    ifMatch: string,
    idempotencyKey = createIdempotencyKey("extract"),
  ): Promise<Versioned<FileExtraction>> {
    const result = await this.api.POST("/files/{fileId}/extractions", {
      params: {
        path: { fileId },
        header: {
          "If-Match": normalizeEtag(ifMatch),
          "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey),
        },
      },
    });
    return versioned(
      fileExtractionSchema,
      result.data,
      result.response,
      "create file extraction",
    );
  }

  async getFileUpload(uploadSessionId: string): Promise<Versioned<FileUploadSession>> {
    const result = await this.api.GET("/file-upload-sessions/{uploadSessionId}", {
      params: { path: { uploadSessionId } },
    });
    return versioned(
      fileUploadSessionSchema,
      result.data,
      result.response,
      "get file upload",
    );
  }

  async abortFileUpload(uploadSessionId: string, ifMatch: string): Promise<void> {
    await this.api.DELETE("/file-upload-sessions/{uploadSessionId}", {
      params: {
        path: { uploadSessionId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
    });
  }

  async listFileUploadParts(uploadSessionId: string): Promise<ListUploadPartsResponse> {
    const result = await this.api.GET("/file-upload-sessions/{uploadSessionId}/parts", {
      params: { path: { uploadSessionId } },
    });
    return parseContract(
      listUploadPartsResponseSchema,
      result.data,
      "list file upload parts",
    );
  }

  async signFileUploadPart(
    uploadSessionId: string,
    partNumber: number,
    request: SignUploadPartRequest,
    ifMatch: string,
  ): Promise<Versioned<SignUploadPartResponse>> {
    const result = await this.api.POST(
      "/file-upload-sessions/{uploadSessionId}/parts/{partNumber}",
      {
        params: {
          path: { uploadSessionId, partNumber },
          header: { "If-Match": normalizeEtag(ifMatch) },
        },
        body: signUploadPartRequestSchema.parse(request),
      },
    );
    return versioned(
      signUploadPartResponseSchema,
      result.data,
      result.response,
      "sign file upload part",
    );
  }

  async completeFileUpload(
    uploadSessionId: string,
    request: CompleteFileUploadRequest,
    ifMatch: string,
    idempotencyKey = createIdempotencyKey("complete"),
  ): Promise<Versioned<CompleteFileUploadResponse>> {
    const result = await this.api.POST("/file-upload-sessions/{uploadSessionId}/complete", {
      params: {
        path: { uploadSessionId },
        header: {
          "If-Match": normalizeEtag(ifMatch),
          "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey),
        },
      },
      body: completeFileUploadRequestSchema.parse(request),
    });
    return versioned(
      completeFileUploadResponseSchema,
      result.data,
      result.response,
      "complete file upload",
    );
  }
}

export function useWorkbenchFilesApi(): WorkbenchFilesApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchFilesApi(api), [api]);
}
