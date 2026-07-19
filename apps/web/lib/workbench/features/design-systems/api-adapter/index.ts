"use client";

import {
  createDesignSystemRequestSchema,
  designSystemCatalogSchema,
  designSystemCreationSchema,
  designSystemImportSchema,
  importDesignSystemRequestSchema,
  type CreateDesignSystemRequest,
  type DesignSystemCatalog,
  type DesignSystemCreation,
  type DesignSystemImport,
  type ImportDesignSystemRequest,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  normalizeIdempotencyKey,
  parseContract,
} from "../../../transport/contracts";
import type { DesignSystemCatalogOptions } from "../domain";

export class WorkbenchDesignSystemsApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listDesignSystemCatalog(
    workspaceId: string,
    options: DesignSystemCatalogOptions = {},
  ): Promise<DesignSystemCatalog> {
    const result = await this.api.GET("/workspaces/{workspaceId}/design-systems", {
      params: { path: { workspaceId }, query: options },
    });
    return parseContract(
      designSystemCatalogSchema,
      result.data,
      "list Design System catalog",
    );
  }

  async createDesignSystem(
    projectId: string,
    request: CreateDesignSystemRequest,
    idempotencyKey = createIdempotencyKey("design-system"),
  ): Promise<DesignSystemCreation> {
    const body = createDesignSystemRequestSchema.parse(request);
    const result = await this.api.POST("/projects/{projectId}/design-systems", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: body as never,
    });
    return parseContract(
      designSystemCreationSchema,
      result.data,
      "create Design System",
    );
  }

  async importDesignSystem(
    projectId: string,
    request: ImportDesignSystemRequest,
    idempotencyKey = createIdempotencyKey("design-system-import"),
  ): Promise<DesignSystemImport> {
    const result = await this.api.POST("/projects/{projectId}/design-system-imports", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: importDesignSystemRequestSchema.parse(request),
    });
    return parseContract(
      designSystemImportSchema,
      result.data,
      "import Design System",
    );
  }
}

export function useWorkbenchDesignSystemsApi(): WorkbenchDesignSystemsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchDesignSystemsApi(api), [api]);
}
