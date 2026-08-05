"use client";

import {
  createExternalExportDeliveryRequestSchema,
  createExportJobRequestSchema,
  createProjectPreviewRequestSchema,
  exportCapabilitiesSchema,
  externalExportDeliveryListSchema,
  externalExportDeliverySchema,
  exportJobListSchema,
  exportJobSchema,
  exportPreviewTokenResponseSchema,
  projectPreviewSchema,
  type CreateExportJobRequest,
  type CreateExternalExportDeliveryRequest,
  type CreateProjectPreviewRequest,
  type ExportCapabilities,
  type ExportJob,
  type ExportJobList,
  type ExportPreviewTokenResponse,
  type ExternalExportDelivery,
  type ExternalExportDeliveryList,
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
    signal?: AbortSignal,
  ): Promise<ProjectPreview> {
    const body = createProjectPreviewRequestSchema.parse(request);
    const result = await this.api.POST("/projects/{projectId}/previews", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body,
      signal,
    });
    return parseContract(projectPreviewSchema, result.data, "create project preview");
  }

  async getProjectPreview(
    previewId: string,
    signal?: AbortSignal,
  ): Promise<ProjectPreview> {
    const result = await this.api.GET("/previews/{previewId}", {
      params: { path: { previewId } },
      signal,
    });
    return parseContract(projectPreviewSchema, result.data, "get project preview");
  }

  async createProjectPreviewToken(
    previewId: string,
    signal?: AbortSignal,
  ): Promise<ExportPreviewTokenResponse> {
    const result = await this.api.POST("/previews/{previewId}/token", {
      params: { path: { previewId } },
      signal,
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

  async listExternalExportDeliveries(exportId: string): Promise<ExternalExportDeliveryList> {
    const result = await this.api.GET("/exports/{exportId}/deliveries", {
      params: { path: { exportId } },
    });
    return parseContract(externalExportDeliveryListSchema, result.data, "list external export deliveries");
  }

  async createExternalExportDelivery(
    exportId: string,
    request: CreateExternalExportDeliveryRequest,
    idempotencyKey = createIdempotencyKey("export-delivery"),
  ): Promise<Versioned<ExternalExportDelivery>> {
    const body = createExternalExportDeliveryRequestSchema.parse(request);
    const result = await this.api.POST("/exports/{exportId}/deliveries", {
      params: {
        path: { exportId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body,
    });
    return versioned(externalExportDeliverySchema, result.data, result.response, "create external export delivery");
  }

  async getExternalExportDelivery(
    deliveryId: string,
    signal?: AbortSignal,
  ): Promise<Versioned<ExternalExportDelivery>> {
    const result = await this.api.GET("/export-deliveries/{deliveryId}", {
      params: { path: { deliveryId } },
      signal,
    });
    return versioned(externalExportDeliverySchema, result.data, result.response, "get external export delivery");
  }

  async confirmExternalExportDelivery(deliveryId: string, ifMatch: string): Promise<Versioned<ExternalExportDelivery>> {
    return this.mutateExternalExportDelivery(deliveryId, "confirm", ifMatch);
  }

  async retryExternalExportDelivery(deliveryId: string, ifMatch: string): Promise<Versioned<ExternalExportDelivery>> {
    return this.mutateExternalExportDelivery(deliveryId, "retry", ifMatch);
  }

  async cancelExternalExportDelivery(deliveryId: string, ifMatch: string): Promise<Versioned<ExternalExportDelivery>> {
    return this.mutateExternalExportDelivery(deliveryId, "cancel", ifMatch);
  }

  private async mutateExternalExportDelivery(
    deliveryId: string,
    action: "confirm" | "retry" | "cancel",
    ifMatch: string,
  ): Promise<Versioned<ExternalExportDelivery>> {
    const path = `/export-deliveries/{deliveryId}/${action}` as const;
    const result = await this.api.POST(path, {
      params: {
        path: { deliveryId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
    });
    return versioned(externalExportDeliverySchema, result.data, result.response, `${action} external export delivery`);
  }
}

export function useWorkbenchExportsApi(): WorkbenchExportsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchExportsApi(api), [api]);
}
