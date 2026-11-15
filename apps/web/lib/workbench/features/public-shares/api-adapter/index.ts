"use client";

import {
  publicArtifactVersionDetailSchema,
  publicShareSchema,
  exportPreviewTokenResponseSchema,
  type ExportPreviewTokenResponse,
  type PublicArtifactVersionDetail,
  type PublicShare,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  immutableVersioned,
  parseContract,
  requireData,
  WorkbenchContractError,
  type ImmutableVersioned,
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

  async createSourcePrototypePreviewToken(
    shareToken: string,
    artifactId: string,
    artifactVersionId: string,
    signal?: AbortSignal,
  ): Promise<ExportPreviewTokenResponse> {
    const result = await this.api.POST(
      "/public/shares/{shareToken}/artifacts/{artifactId}/versions/{artifactVersionId}/preview-token" as never,
      { params: { path: { shareToken, artifactId, artifactVersionId } }, signal } as never,
    );
    return parseContract(exportPreviewTokenResponseSchema, result.data, "create public source prototype preview");
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
