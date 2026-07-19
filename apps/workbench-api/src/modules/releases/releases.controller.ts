import { Body, Controller, Get, Headers, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  createProjectReleaseRequestSchema,
  type CreateProjectReleaseRequest,
} from "@workbench/workbench-contracts";
import { entityTagMatches } from "../../common/byte-content.js";
import { parseIfMatch } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { releaseDigestEtag } from "./release.mapper.js";
import { ReleasesService } from "./releases.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class ReleasesController {
  constructor(private readonly releases: ReleasesService) {}

  @Get("projects/:projectId/releases")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.releases.list(principal.id, projectId, cursor || undefined, parseLimit(limit));
  }

  @Post("projects/:projectId/releases")
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createProjectReleaseRequestSchema)) body: CreateProjectReleaseRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const release = await this.releases.create(
      principal.id,
      projectId,
      parseIfMatch(ifMatch),
      idempotencyKey,
      body,
    );
    response.setHeader("ETag", releaseDigestEtag(release));
    response.setHeader("Location", `/api/v1/releases/${release.id}`);
    return release;
  }

  @Get("releases/:releaseId")
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("releaseId") releaseId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const release = await this.releases.get(principal.id, releaseId);
    const etag = releaseDigestEtag(release);
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, no-cache");
    if (entityTagMatches(ifNoneMatch, etag)) {
      response.status(304);
      return undefined;
    }
    return release;
  }
}

export function parseReleaseLimit(value?: string) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}

const parseLimit = parseReleaseLimit;
