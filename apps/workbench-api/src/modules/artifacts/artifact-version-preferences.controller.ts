import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  artifactVersionPreferenceTargetQuerySchema,
  updateArtifactVersionPreferenceRequestSchema,
  type ArtifactVersionPreferenceTargetQuery,
  type UpdateArtifactVersionPreferenceRequest,
} from "@workbench/workbench-contracts";
import { entityTagMatches } from "../../common/byte-content.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import {
  artifactVersionPreferenceEtag,
  parseArtifactVersionPreferenceIfMatch,
} from "./artifact-version-preference-etag.js";
import { ArtifactVersionPreferencesService } from "./artifact-version-preferences.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class ArtifactVersionPreferencesController {
  constructor(private readonly preferences: ArtifactVersionPreferencesService) {}

  @Get("projects/:projectId/artifact-version-favorites")
  async listFavorites(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("cursor") cursor: string | string[] | undefined,
    @Query("limit") limit: string | string[] | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return this.preferences.listFavorites(
      principal.id,
      projectId,
      parseFavoriteCursor(cursor),
      parseFavoriteLimit(limit),
    );
  }

  @Get("artifacts/:artifactId/versions/:artifactVersionId/preference")
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") artifactVersionId: string,
    @Query(new ZodValidationPipe(artifactVersionPreferenceTargetQuerySchema))
    query: ArtifactVersionPreferenceTargetQuery,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const preference = await this.preferences.get(
      principal.id,
      artifactId,
      artifactVersionId,
      query.screenId ?? null,
    );
    const etag = artifactVersionPreferenceEtag({
      principalId: principal.id,
      artifactId,
      artifactVersionId,
      screenId: query.screenId ?? null,
    }, preference.revision);
    response.setHeader("ETag", etag);
    response.setHeader("Cache-Control", "private, no-cache");
    if (entityTagMatches(ifNoneMatch, etag)) {
      response.status(304);
      return undefined;
    }
    return preference;
  }

  @Put("artifacts/:artifactId/versions/:artifactVersionId/preference")
  async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("artifactId") artifactId: string,
    @Param("artifactVersionId") artifactVersionId: string,
    @Query(new ZodValidationPipe(artifactVersionPreferenceTargetQuerySchema))
    query: ArtifactVersionPreferenceTargetQuery,
    @Headers("if-match") ifMatch: string | undefined,
    @Body(new ZodValidationPipe(updateArtifactVersionPreferenceRequestSchema))
    body: UpdateArtifactVersionPreferenceRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const etagScope = {
      principalId: principal.id,
      artifactId,
      artifactVersionId,
      screenId: query.screenId ?? null,
    };
    const preference = await this.preferences.update(
      principal.id,
      artifactId,
      artifactVersionId,
      query.screenId ?? null,
      parseArtifactVersionPreferenceIfMatch(ifMatch, etagScope),
      body,
    );
    response.setHeader("ETag", artifactVersionPreferenceEtag(etagScope, preference.revision));
    response.setHeader("Cache-Control", "private, no-store");
    return preference;
  }
}

function parseFavoriteCursor(value: string | string[] | undefined): string | undefined {
  value = singleQueryValue("cursor", value);
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 2_048) {
    throw validationProblem("cursor must contain between 1 and 2048 characters");
  }
  return value;
}

function parseFavoriteLimit(value: string | string[] | undefined): number | undefined {
  value = singleQueryValue("limit", value);
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}

function singleQueryValue(name: string, value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) throw validationProblem(`${name} must be provided at most once`);
  return value;
}
