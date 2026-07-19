"use client";

import {
  createImportSourceRequestSchema,
  importSourceListSchema,
  importSourceSchema,
  type CreateImportSourceRequest,
  type ImportSource,
  type ImportSourceList,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import {
  useOptionalWorkbenchTransport,
  useWorkbenchTransport,
} from "../../../transport/context";
import {
  createIdempotencyKey,
  normalizeEtag,
  normalizeIdempotencyKey,
  parseContract,
  versioned,
  type Versioned,
} from "../../../transport/contracts";
import type { ImportSourceListOptions } from "../domain";

export class WorkbenchImportSourcesApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listImportSources(
    projectId: string,
    options: ImportSourceListOptions = {},
  ): Promise<ImportSourceList> {
    const result = await this.api.GET("/projects/{projectId}/import-sources", {
      params: { path: { projectId }, query: options },
    });
    return parseContract(importSourceListSchema, result.data, "list import sources");
  }

  async createImportSource(
    projectId: string,
    request: CreateImportSourceRequest,
    idempotencyKey = createIdempotencyKey("import-source"),
  ): Promise<Versioned<ImportSource>> {
    const result = await this.api.POST("/projects/{projectId}/import-sources", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: createImportSourceRequestSchema.parse(request),
    });
    return versioned(
      importSourceSchema,
      result.data,
      result.response,
      "create import source",
    );
  }

  async getImportSource(sourceId: string): Promise<Versioned<ImportSource>> {
    const result = await this.api.GET("/import-sources/{sourceId}", {
      params: { path: { sourceId } },
    });
    return versioned(importSourceSchema, result.data, result.response, "get import source");
  }

  async deleteImportSource(sourceId: string, ifMatch: string): Promise<void> {
    await this.api.DELETE("/import-sources/{sourceId}", {
      params: {
        path: { sourceId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
    });
  }
}

export function useWorkbenchImportSourcesApi(): WorkbenchImportSourcesApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchImportSourcesApi(api), [api]);
}

export function useOptionalWorkbenchImportSourcesApi(): WorkbenchImportSourcesApi | null {
  const transport = useOptionalWorkbenchTransport();
  return useMemo(
    () => (transport ? new WorkbenchImportSourcesApi(transport.api) : null),
    [transport],
  );
}
