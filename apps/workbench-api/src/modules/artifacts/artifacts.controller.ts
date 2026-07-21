import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  artifactKindSchema,
  createArtifactRequestSchema,
  createArtifactVersionRequestSchema,
  type Artifact,
  type CreateArtifactRequest,
  type CreateArtifactVersionRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { entityTagMatches, UnsatisfiedByteRangeProblem } from "../../common/byte-content.js";
import { validationProblem } from "../../common/problem-details.js";
import { httpResponseAbortSignalArgument } from "../../common/http-request-abort.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { ArtifactsService } from "./artifacts.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class ArtifactsController {
  constructor(private readonly artifacts: ArtifactsService) {}

  @Get("projects/:projectId/artifacts")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("kind") kind?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.artifacts.list(
      principal.id,
      projectId,
      parseArtifactKind(kind),
      cursor || undefined,
      parseArtifactLimit(limit),
    );
  }

  @Post("projects/:projectId/artifacts")
  @HttpCode(201)
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createArtifactRequestSchema)) body: CreateArtifactRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const result = await this.artifacts.create(principal.id, projectId, idempotencyKey, body);
    response.setHeader(
      "Location",
      `/api/v1/artifacts/${result.artifact.id}/versions/${result.artifactVersion.artifactVersionId}`,
    );
    response.setHeader("Cache-Control", "private, no-store");
    return result;
  }

  @Get("artifacts/:artifactId")
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("artifactId") artifactId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const artifact = await this.artifacts.get(principal.id, artifactId);
    const etag = revisionEtag(artifact.revision);
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, no-cache");
    if (entityTagMatches(ifNoneMatch, etag)) {
      response.status(304);
      return undefined;
    }
    return artifact;
  }

  @Get("artifacts/:artifactId/versions")
  listVersions(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("artifactId") artifactId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.artifacts.listVersions(
      principal.id,
      artifactId,
      cursor || undefined,
      parseArtifactLimit(limit),
    );
  }

  @Post("artifacts/:artifactId/versions")
  @HttpCode(201)
  async createVersion(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("artifactId") artifactId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createArtifactVersionRequestSchema)) body: CreateArtifactVersionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const result = await this.artifacts.createVersion(
      principal.id,
      artifactId,
      parseIfMatch(ifMatch),
      idempotencyKey,
      body,
    );
    response.setHeader("ETag", revisionEtag(result.artifactRevision));
    response.setHeader(
      "Location",
      `/api/v1/artifacts/${artifactId}/versions/${result.detail.artifactVersionId}`,
    );
    response.setHeader("Cache-Control", "private, no-store");
    return result.detail;
  }

  @Get("artifacts/:artifactId/versions/:artifactVersionId")
  async getVersion(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") artifactVersionId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.artifacts.getVersion(principal.id, artifactId, artifactVersionId);
    response.setHeader("ETag", result.etag);
    response.setHeader("Cache-Control", "private, no-cache");
    if (entityTagMatches(ifNoneMatch, result.etag)) {
      response.status(304);
      return undefined;
    }
    return result.detail;
  }

  @Get("artifacts/:artifactId/versions/:artifactVersionId/content")
  async getVersionContent(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") artifactVersionId: string,
    @Headers("range") range: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    let result;
    try {
      result = await this.artifacts.getContent(
        principal.id,
        artifactId,
        artifactVersionId,
        range,
        ifNoneMatch,
        ...httpResponseAbortSignalArgument(response),
      );
    } catch (error) {
      if (error instanceof UnsatisfiedByteRangeProblem) {
        response.setHeader("Content-Range", `bytes */${error.byteSize}`);
      }
      throw error;
    }

    response.setHeader("ETag", result.etag);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, no-cache");
    if (result.notModified) {
      response.status(304);
      return undefined;
    }
    response.setHeader("Content-Type", result.mediaType);
    response.setHeader("Content-Length", String(result.byteSize));
    if (result.range) {
      response.status(206);
      response.setHeader("Content-Range", result.contentRange!);
    }
    return new StreamableFile(result.body);
  }

  @Get("artifacts/:artifactId/versions/:artifactVersionId/assets/:assetId/content")
  async getVersionAssetContent(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") artifactVersionId: string,
    @Param("assetId") assetId: string,
    @Headers("range") range: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    let result;
    try {
      result = await this.artifacts.getAssetContent(
        principal.id,
        artifactId,
        artifactVersionId,
        assetId,
        range,
        ifNoneMatch,
        ...httpResponseAbortSignalArgument(response),
      );
    } catch (error) {
      if (error instanceof UnsatisfiedByteRangeProblem) {
        response.setHeader("Content-Range", `bytes */${error.byteSize}`);
      }
      throw error;
    }

    response.setHeader("ETag", result.etag);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "private, no-cache");
    if (result.notModified) {
      response.status(304);
      return undefined;
    }
    response.setHeader("Content-Type", result.mediaType);
    response.setHeader("Content-Length", String(result.byteSize));
    if (result.range) {
      response.status(206);
      response.setHeader("Content-Range", result.contentRange!);
    }
    return new StreamableFile(result.body);
  }
}

export function parseArtifactKind(value?: string): Artifact["kind"] | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = artifactKindSchema.safeParse(value);
  if (!parsed.success) throw validationProblem("kind is not a supported Artifact kind");
  return parsed.data;
}

export function parseArtifactLimit(value?: string) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}
