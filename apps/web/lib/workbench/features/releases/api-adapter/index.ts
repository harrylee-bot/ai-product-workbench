"use client";

import {
  createProjectReleaseRequestSchema,
  projectReleaseListSchema,
  projectReleaseSchema,
  type CreateProjectReleaseRequest,
  type ProjectRelease,
  type ProjectReleaseList,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  immutableVersioned,
  normalizeEtag,
  normalizeIdempotencyKey,
  parseContract,
  type CursorPageOptions,
  type ImmutableVersioned,
} from "../../../transport/contracts";

export class WorkbenchReleasesApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listProjectReleases(
    projectId: string,
    options: CursorPageOptions = {},
  ): Promise<ProjectReleaseList> {
    const result = await this.api.GET("/projects/{projectId}/releases", {
      params: { path: { projectId }, query: options },
    });
    return parseContract(
      projectReleaseListSchema,
      result.data,
      "list project releases",
    );
  }

  async createProjectRelease(
    projectId: string,
    request: CreateProjectReleaseRequest,
    ifMatch: string,
    idempotencyKey = createIdempotencyKey("release"),
  ): Promise<ImmutableVersioned<ProjectRelease>> {
    const result = await this.api.POST("/projects/{projectId}/releases", {
      params: {
        path: { projectId },
        header: {
          "If-Match": normalizeEtag(ifMatch),
          "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey),
        },
      },
      body: createProjectReleaseRequestSchema.parse(request),
    });
    return immutableVersioned(
      projectReleaseSchema,
      result.data,
      result.response,
      "create project release",
    );
  }

  async getProjectRelease(
    releaseId: string,
  ): Promise<ImmutableVersioned<ProjectRelease>> {
    const result = await this.api.GET("/releases/{releaseId}", {
      params: { path: { releaseId } },
    });
    return immutableVersioned(
      projectReleaseSchema,
      result.data,
      result.response,
      "get project release",
    );
  }
}

export function useWorkbenchReleasesApi(): WorkbenchReleasesApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchReleasesApi(api), [api]);
}
