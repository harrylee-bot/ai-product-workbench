"use client";

import {
  createExportJobRequestSchema,
  createProjectPreviewRequestSchema,
  exportCapabilitiesSchema,
  exportJobListSchema,
  exportJobSchema,
  exportPreviewTokenResponseSchema,
  projectPreviewSchema,
  type CreateExportJobRequest,
  type CreateProjectPreviewRequest,
  type ExportCapabilities,
  type ExportJob,
  type ExportJobList,
  type ExportPreviewTokenResponse,
  type ProjectPreview,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { isWorkbenchBlob } from "../../../transport/blob";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  normalizeEtag,
  normalizeIdempotencyKey,
  normalizeStrongEtag,
  parseContract,
  requireData,
  versioned,
  WorkbenchContractError,
  type CursorPageOptions,
  type ImmutableVersioned,
  type Versioned,
} from "../../../transport/contracts";

export class WorkbenchExportsApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listExportJobs(
    projectId: string,
    options: CursorPageOptions = {},
  ): Promise<ExportJobList> {
    const result = await this.api.GET("/projects/{projectId}/exports", {
      params: { path: { projectId }, query: options },
    });
    return parseContract(exportJobListSchema, result.data, "list export jobs");
  }

  async getExportCapabilities(): Promise<ExportCapabilities> {
    const result = await this.api.GET("/exports/capabilities");
    return parseContract(
      exportCapabilitiesSchema,
      result.data,
      "get export capabilities",
    );
  }

  async createExportJob(
    projectId: string,
    request: CreateExportJobRequest,
    idempotencyKey = createIdempotencyKey("export"),
  ): Promise<Versioned<ExportJob>> {
    const body = createExportJobRequestSchema.parse(request);
    const result = await this.api.POST("/projects/{projectId}/exports", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      // openapi-fetch's exact-body helper cannot represent a recursive JSON value.
      body: body as never,
    });
    return versioned(exportJobSchema, result.data, result.response, "create export job");
  }

  async getExportJob(exportId: string): Promise<Versioned<ExportJob>> {
    const result = await this.api.GET("/exports/{exportId}", {
      params: { path: { exportId } },
    });
    return versioned(exportJobSchema, result.data, result.response, "get export job");
  }

  async cancelExportJob(
    exportId: string,
    ifMatch: string,
  ): Promise<Versioned<ExportJob>> {
    const result = await this.api.POST("/exports/{exportId}/cancel", {
      params: {
        path: { exportId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
    });
    return versioned(exportJobSchema, result.data, result.response, "cancel export job");
  }

  async createExportPreviewToken(exportId: string): Promise<ExportPreviewTokenResponse> {
    const result = await this.api.POST("/exports/{exportId}/preview-token", {
      params: { path: { exportId } },
    });
    return parseContract(
      exportPreviewTokenResponseSchema,
      result.data,
      "create export preview token",
    );
  }

  async createProjectPreview(
    projectId: string,
    request: CreateProjectPreviewRequest,
    idempotencyKey = createIdempotencyKey("preview"),
  ): Promise<ProjectPreview> {
    const body = createProjectPreviewRequestSchema.parse(request);
    const result = await this.api.POST("/projects/{projectId}/previews", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body,
    });
    return parseContract(projectPreviewSchema, result.data, "create project preview");
  }

  async getProjectPreview(previewId: string): Promise<ProjectPreview> {
    const result = await this.api.GET("/previews/{previewId}", {
      params: { path: { previewId } },
    });
    return parseContract(projectPreviewSchema, result.data, "get project preview");
  }

  async createProjectPreviewToken(previewId: string): Promise<ExportPreviewTokenResponse> {
    const result = await this.api.POST("/previews/{previewId}/token", {
      params: { path: { previewId } },
    });
    return parseContract(
      exportPreviewTokenResponseSchema,
      result.data,
      "create project preview token",
    );
  }

  async getExportContent(exportId: string): Promise<ImmutableVersioned<Blob>> {
    const result = await this.api.GET("/exports/{exportId}/content", {
      params: { path: { exportId } },
      headers: { Accept: "application/octet-stream" },
      parseAs: "blob",
    });
    const content = requireData(result.data, "get export content");
    if (!isWorkbenchBlob(content)) {
      throw new WorkbenchContractError("get export content");
    }
    const etag = result.response.headers.get("etag");
    if (!etag) throw new WorkbenchContractError("get export content ETag");
    return { value: content, etag: normalizeStrongEtag(etag) };
  }

}

export function useWorkbenchExportsApi(): WorkbenchExportsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchExportsApi(api), [api]);
}
