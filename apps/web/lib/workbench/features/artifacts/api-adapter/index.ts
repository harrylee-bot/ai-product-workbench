"use client";

import {
  artifactCreationSchema,
  artifactListSchema,
  artifactSchema,
  artifactVersionDetailSchema,
  artifactVersionFavoriteListSchema,
  artifactVersionListSchema,
  artifactVersionPreferenceSchema,
  createArtifactRequestSchema,
  createArtifactVersionRequestSchema,
  updateArtifactVersionPreferenceRequestSchema,
  type Artifact,
  type ArtifactCreation,
  type ArtifactList,
  type ArtifactVersionDetail,
  type ArtifactVersionFavoriteList,
  type ArtifactVersionList,
  type ArtifactVersionPreference,
  type CreateArtifactRequest,
  type CreateArtifactVersionRequest,
  type UpdateArtifactVersionPreferenceRequest,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { isWorkbenchBlob } from "../../../transport/blob";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  immutableVersioned,
  normalizeEtag,
  normalizeStrongEtag,
  normalizeIdempotencyKey,
  parseContract,
  requireData,
  strongVersioned,
  versioned,
  WorkbenchContractError,
  type ConditionalVersioned,
  type CursorPageOptions,
  type ImmutableVersioned,
  type Versioned,
} from "../../../transport/contracts";
import type { ArtifactListOptions } from "../domain";

export class WorkbenchArtifactsApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listArtifacts(
    projectId: string,
    options: ArtifactListOptions = {},
  ): Promise<ArtifactList> {
    const result = await this.api.GET("/projects/{projectId}/artifacts", {
      params: { path: { projectId }, query: options },
    });
    return parseContract(artifactListSchema, result.data, "list artifacts");
  }

  async createArtifact(
    projectId: string,
    request: CreateArtifactRequest,
    idempotencyKey = createIdempotencyKey("artifact"),
  ): Promise<ArtifactCreation> {
    const result = await this.api.POST("/projects/{projectId}/artifacts", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: createArtifactRequestSchema.parse(request),
    });
    return parseContract(
      artifactCreationSchema,
      result.data,
      "create artifact",
    );
  }

  async getArtifact(artifactId: string): Promise<Versioned<Artifact>> {
    const result = await this.api.GET("/artifacts/{artifactId}", {
      params: { path: { artifactId } },
    });
    return versioned(artifactSchema, result.data, result.response, "get artifact");
  }

  async createArtifactVersion(
    artifactId: string,
    request: CreateArtifactVersionRequest,
    ifMatch: string,
    idempotencyKey = createIdempotencyKey("artifact-version"),
  ): Promise<Versioned<ArtifactVersionDetail>> {
    const result = await this.api.POST("/artifacts/{artifactId}/versions", {
      params: {
        path: { artifactId },
        header: {
          "If-Match": normalizeEtag(ifMatch),
          "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey),
        },
      },
      body: createArtifactVersionRequestSchema.parse(request),
    });
    return versioned(
      artifactVersionDetailSchema,
      result.data,
      result.response,
      "create artifact version",
    );
  }

  async listArtifactVersions(
    artifactId: string,
    options: CursorPageOptions = {},
  ): Promise<ArtifactVersionList> {
    const result = await this.api.GET("/artifacts/{artifactId}/versions", {
      params: { path: { artifactId }, query: options },
    });
    return parseContract(
      artifactVersionListSchema,
      result.data,
      "list artifact versions",
    );
  }

  async listArtifactVersionFavorites(
    projectId: string,
    options: CursorPageOptions = {},
  ): Promise<ArtifactVersionFavoriteList> {
    const result = await this.api.GET(
      "/projects/{projectId}/artifact-version-favorites",
      {
        params: { path: { projectId }, query: options },
      },
    );
    return parseContract(
      artifactVersionFavoriteListSchema,
      result.data,
      "list artifact version favorites",
    );
  }

  async getArtifactVersion(
    artifactId: string,
    artifactVersionId: string,
  ): Promise<ImmutableVersioned<ArtifactVersionDetail>> {
    const result = await this.api.GET("/artifacts/{artifactId}/versions/{artifactVersionId}", {
      params: { path: { artifactId, artifactVersionId } },
    });
    return immutableVersioned(
      artifactVersionDetailSchema,
      result.data,
      result.response,
      "get artifact version",
    );
  }

  async getArtifactVersionPreference(
    artifactId: string,
    artifactVersionId: string,
    screenId: string | null = null,
    cached?: Versioned<ArtifactVersionPreference>,
    signal?: AbortSignal,
  ): Promise<Versioned<ArtifactVersionPreference>> {
    const reusable = cached
      && preferenceMatchesTarget(cached.value, artifactId, artifactVersionId, screenId)
      && artifactVersionPreferenceEtagMatchesRevision(cached.etag, cached.value.revision)
      ? cached
      : undefined;
    const result = await this.getArtifactVersionPreferenceConditional(
      artifactId,
      artifactVersionId,
      screenId,
      reusable?.etag,
      signal,
    );
    if (result.status === "modified") return result.representation;
    if (reusable?.etag === result.etag) return reusable;

    const fallback = await this.getArtifactVersionPreferenceConditional(
      artifactId,
      artifactVersionId,
      screenId,
      undefined,
      signal,
    );
    if (fallback.status === "modified") return fallback.representation;
    throw new WorkbenchContractError(
      "get artifact version preference unconditional 304",
    );
  }

  private async getArtifactVersionPreferenceConditional(
    artifactId: string,
    artifactVersionId: string,
    screenId: string | null,
    ifNoneMatch: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ConditionalVersioned<ArtifactVersionPreference>> {
    const result = await this.api.GET(
      "/artifacts/{artifactId}/versions/{artifactVersionId}/preference",
      {
        params: {
          path: { artifactId, artifactVersionId },
          query: screenId === null ? {} : { screenId },
          header: ifNoneMatch === undefined
            ? {}
            : { "If-None-Match": normalizeArtifactVersionPreferenceEtag(ifNoneMatch) },
        },
        signal,
      },
    );
    if (result.response.status === 304) {
      const etag = result.response.headers.get("etag");
      if (!etag) throw new WorkbenchContractError("get artifact version preference 304 ETag");
      return {
        status: "not-modified",
        etag: normalizeArtifactVersionPreferenceEtag(etag),
      };
    }
    const representation = strongVersioned(
      artifactVersionPreferenceSchema,
      result.data,
      result.response,
      "get artifact version preference",
    );
    if (!preferenceMatchesTarget(
      representation.value,
      artifactId,
      artifactVersionId,
      screenId,
    )) {
      throw new WorkbenchContractError("get artifact version preference identity");
    }
    return {
      status: "modified",
      representation: normalizeArtifactVersionPreferenceRepresentation(representation),
    };
  }

  async updateArtifactVersionPreference(
    artifactId: string,
    artifactVersionId: string,
    request: UpdateArtifactVersionPreferenceRequest,
    ifMatch: string,
    screenId: string | null = null,
  ): Promise<Versioned<ArtifactVersionPreference>> {
    const result = await this.api.PUT(
      "/artifacts/{artifactId}/versions/{artifactVersionId}/preference",
      {
        params: {
          path: { artifactId, artifactVersionId },
          query: screenId === null ? {} : { screenId },
          header: { "If-Match": normalizeArtifactVersionPreferenceEtag(ifMatch) },
        },
        body: updateArtifactVersionPreferenceRequestSchema.parse(request),
      },
    );
    const representation = strongVersioned(
      artifactVersionPreferenceSchema,
      result.data,
      result.response,
      "update artifact version preference",
    );
    if (!preferenceMatchesTarget(
      representation.value,
      artifactId,
      artifactVersionId,
      screenId,
    )) {
      throw new WorkbenchContractError("update artifact version preference identity");
    }
    return normalizeArtifactVersionPreferenceRepresentation(representation);
  }

  async getArtifactVersionContent(
    artifactId: string,
    artifactVersionId: string,
  ): Promise<Blob> {
    const result = await this.api.GET(
      "/artifacts/{artifactId}/versions/{artifactVersionId}/content",
      {
        params: { path: { artifactId, artifactVersionId } },
        headers: { Accept: "application/octet-stream" },
        parseAs: "blob",
      },
    );
    const content = requireData(result.data, "get artifact version content");
    if (!isWorkbenchBlob(content)) {
      throw new WorkbenchContractError("get artifact version content");
    }
    return content;
  }

  async getArtifactVersionAssetContent(
    artifactId: string,
    artifactVersionId: string,
    assetId: string,
  ): Promise<Blob> {
    const result = await this.api.GET(
      "/artifacts/{artifactId}/versions/{artifactVersionId}/assets/{assetId}/content",
      {
        params: { path: { artifactId, artifactVersionId, assetId } },
        headers: { Accept: "application/octet-stream" },
        parseAs: "blob",
      },
    );
    const content = requireData(result.data, "get artifact version asset content");
    if (!isWorkbenchBlob(content)) {
      throw new WorkbenchContractError("get artifact version asset content");
    }
    return content;
  }
}

function preferenceMatchesTarget(
  preference: ArtifactVersionPreference,
  artifactId: string,
  artifactVersionId: string,
  screenId: string | null,
): boolean {
  return preference.artifactId === artifactId
    && preference.artifactVersionId === artifactVersionId
    && preference.screenId === screenId;
}

const artifactVersionPreferenceEtagPattern = /^"avp1\.(0|[1-9]\d*)\.[A-Za-z0-9_-]{43}"$/u;

function artifactVersionPreferenceEtagMatchesRevision(
  etag: string,
  revision: number,
): boolean {
  const match = artifactVersionPreferenceEtagPattern.exec(etag);
  return Boolean(match && Number(match[1]) === revision);
}

function normalizeArtifactVersionPreferenceEtag(etag: string): string {
  let normalized: string;
  try {
    normalized = normalizeStrongEtag(etag);
  } catch (error) {
    throw new WorkbenchContractError("ArtifactVersion preference ETag", { cause: error });
  }
  if (!artifactVersionPreferenceEtagPattern.test(normalized)) {
    throw new WorkbenchContractError("ArtifactVersion preference scoped ETag");
  }
  return normalized;
}

function normalizeArtifactVersionPreferenceRepresentation(
  representation: Versioned<ArtifactVersionPreference>,
): Versioned<ArtifactVersionPreference> {
  const etag = normalizeArtifactVersionPreferenceEtag(representation.etag);
  if (!artifactVersionPreferenceEtagMatchesRevision(etag, representation.value.revision)) {
    throw new WorkbenchContractError("ArtifactVersion preference ETag revision");
  }
  return { ...representation, etag };
}

export function useWorkbenchArtifactsApi(): WorkbenchArtifactsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchArtifactsApi(api), [api]);
}
