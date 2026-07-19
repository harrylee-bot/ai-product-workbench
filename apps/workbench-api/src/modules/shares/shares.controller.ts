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
  rotateShareGrantRequestSchema,
  type RotateShareGrantRequest,
} from "@workbench/workbench-contracts";
import { entityTagMatches, UnsatisfiedByteRangeProblem } from "../../common/byte-content.js";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { SharesService } from "./shares.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class ShareGrantsController {
  constructor(private readonly shares: SharesService) {}

  @Get("projects/:projectId/shares")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.shares.list(principal.id, projectId, cursor || undefined, parseShareLimit(limit));
  }

  @Post("projects/:projectId/shares/rotate")
  async rotate(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(rotateShareGrantRequestSchema)) body: RotateShareGrantRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const result = await this.shares.rotate(principal.id, projectId, idempotencyKey, body);
    response.setHeader("ETag", revisionEtag(result.share.revision));
    response.setHeader("Location", `/api/v1/shares/${result.share.id}`);
    response.setHeader("Cache-Control", "no-store");
    return result;
  }

  @Post("projects/:projectId/shares/revoke-all")
  @HttpCode(200)
  revokeProjectShares(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
  ) {
    return this.shares.revokeProjectShares(principal.id, projectId);
  }

  @Get("shares/:shareId")
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("shareId") shareId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const share = await this.shares.get(principal.id, shareId);
    const etag = revisionEtag(share.revision);
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, no-store");
    if (entityTagMatches(ifNoneMatch, etag)) {
      response.status(304);
      return undefined;
    }
    return share;
  }

  @Post("shares/:shareId/revoke")
  @HttpCode(200)
  async revoke(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("shareId") shareId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const share = await this.shares.revoke(principal.id, shareId, parseIfMatch(ifMatch));
    response.setHeader("ETag", revisionEtag(share.revision));
    return share;
  }
}

@Controller()
export class PublicSharesController {
  constructor(private readonly shares: SharesService) {}

  @Get("public/shares/:shareToken")
  async get(
    @Param("shareToken") shareToken: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.shares.getPublic(shareToken);
    response.setHeader("ETag", result.etag);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (entityTagMatches(ifNoneMatch, result.etag)) {
      response.status(304);
      return undefined;
    }
    return result.share;
  }

  @Get("public/shares/:shareToken/artifacts/:artifactId/versions/:artifactVersionId")
  async getArtifactVersion(
    @Param("shareToken") shareToken: string,
    @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") artifactVersionId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.shares.getPublicArtifactVersion(
      shareToken,
      artifactId,
      artifactVersionId,
    );
    response.setHeader("ETag", result.etag);
    setPublicCapabilityHeaders(response);
    if (entityTagMatches(ifNoneMatch, result.etag)) {
      response.status(304);
      return undefined;
    }
    return result.detail;
  }

  @Get("public/shares/:shareToken/artifacts/:artifactId/versions/:artifactVersionId/content")
  async getArtifactContent(
    @Param("shareToken") shareToken: string,
    @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") artifactVersionId: string,
    @Headers("range") range: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    let result;
    try {
      result = await this.shares.getPublicArtifactContent(
        shareToken,
        artifactId,
        artifactVersionId,
        range,
        ifNoneMatch,
      );
    } catch (error) {
      if (error instanceof UnsatisfiedByteRangeProblem) {
        response.setHeader("Content-Range", `bytes */${error.byteSize}`);
      }
      throw error;
    }

    response.setHeader("ETag", result.etag);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("X-Content-Type-Options", "nosniff");
    setPublicCapabilityHeaders(response);
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

  @Get("public/shares/:shareToken/artifacts/:artifactId/versions/:artifactVersionId/assets/:assetId/content")
  async getArtifactAssetContent(
    @Param("shareToken") shareToken: string,
    @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") artifactVersionId: string,
    @Param("assetId") assetId: string,
    @Headers("range") range: string | undefined,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    let result;
    try {
      result = await this.shares.getPublicArtifactAssetContent(
        shareToken,
        artifactId,
        artifactVersionId,
        assetId,
        range,
        ifNoneMatch,
      );
    } catch (error) {
      if (error instanceof UnsatisfiedByteRangeProblem) {
        response.setHeader("Content-Range", `bytes */${error.byteSize}`);
      }
      throw error;
    }

    response.setHeader("ETag", result.etag);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("X-Content-Type-Options", "nosniff");
    setPublicCapabilityHeaders(response);
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

function setPublicCapabilityHeaders(response: Response) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}

export function parseShareLimit(value?: string) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}
