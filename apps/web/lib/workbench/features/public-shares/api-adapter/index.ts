"use client";

import {
  createProjectRemixRequestSchema,
  createProjectRemixResponseSchema,
  publicArtifactVersionDetailSchema,
  publicShareSchema,
  type CreateProjectRemixRequest,
  type CreateProjectRemixResponse,
  type PublicArtifactVersionDetail,
  type PublicShare,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  immutableVersioned,
  normalizeIdempotencyKey,
  requireData,
  versioned,
  WorkbenchContractError,
  type ImmutableVersioned,
  type Versioned,
} from "../../../transport/contracts";

export class WorkbenchPublicSharesApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async getPublicShare(shareToken: string): Promise<ImmutableVersioned<PublicShare>> {
    const result = await this.api.GET("/public/shares/{shareToken}", {
      params: { path: { shareToken } },
    });
    return immutableVersioned(
      publicShareSchema,
      result.data,
      result.response,
      "get public share",
    );
  }

  async getPublicSharedArtifactVersion(
    shareToken: string,
    artifactId: string,
    artifactVersionId: string,
  ): Promise<ImmutableVersioned<PublicArtifactVersionDetail>> {
    const result = await this.api.GET(
      "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}",
      { params: { path: { shareToken, artifactId, artifactVersionId } } },
    );
    return immutableVersioned(
      publicArtifactVersionDetailSchema,
      result.data,
      result.response,
      "get public shared artifact version",
    );
  }

  async getPublicSharedArtifactVersionAssetContent(
    shareToken: string,
    artifactId: string,
    artifactVersionId: string,
    assetId: string,
  ): Promise<Blob> {
    const result = await this.api.GET(
      "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/assets/{assetId}/content",
      {
        params: { path: { shareToken, artifactId, artifactVersionId, assetId } },
        headers: { Accept: "application/octet-stream" },
        parseAs: "blob",
      },
    );
    return requireBlob(result.data, "get public shared artifact asset content");
  }

  async getPublicSharedArtifactVersionContent(
    shareToken: string,
    artifactId: string,
    artifactVersionId: string,
  ): Promise<Blob> {
    const result = await this.api.GET(
      "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/content",
      {
        params: { path: { shareToken, artifactId, artifactVersionId } },
        headers: { Accept: "application/octet-stream" },
        parseAs: "blob",
      },
    );
    return requireBlob(result.data, "get public shared artifact content");
  }

  async createProjectRemix(
    shareToken: string,
    request: CreateProjectRemixRequest,
    idempotencyKey = createIdempotencyKey("remix"),
  ): Promise<Versioned<CreateProjectRemixResponse>> {
    const result = await this.api.POST("/public/shares/{shareToken}/remixes", {
      params: {
        path: { shareToken },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: createProjectRemixRequestSchema.parse(request),
    });
    return versioned(
      createProjectRemixResponseSchema,
      result.data,
      result.response,
      "create project remix",
    );
  }
}

export function useWorkbenchPublicSharesApi(): WorkbenchPublicSharesApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchPublicSharesApi(api), [api]);
}

function requireBlob(data: Blob | undefined, operation: string): Blob {
  const content = requireData(data, operation);
  if (!(content instanceof Blob)) throw new WorkbenchContractError(operation);
  return content;
}
