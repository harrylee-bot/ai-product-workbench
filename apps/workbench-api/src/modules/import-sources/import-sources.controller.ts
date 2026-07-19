import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  createImportSourceRequestSchema,
  type CreateImportSourceRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { ImportSourcesService } from "./import-sources.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class ImportSourcesController {
  constructor(private readonly sources: ImportSourcesService) {}

  @Get("projects/:projectId/import-sources")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.sources.list(principal.id, projectId, cursor || undefined, parseLimit(limit));
  }

  @Post("projects/:projectId/import-sources")
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createImportSourceRequestSchema)) body: CreateImportSourceRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const source = await this.sources.create(principal.id, projectId, idempotencyKey, body);
    response.setHeader("ETag", revisionEtag(source.revision));
    response.setHeader("Location", `/api/v1/import-sources/${source.id}`);
    response.setHeader("Cache-Control", "private, no-store");
    return source;
  }

  @Get("import-sources/:sourceId")
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("sourceId") sourceId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const source = await this.sources.get(principal.id, sourceId);
    response.setHeader("ETag", revisionEtag(source.revision));
    response.setHeader("Cache-Control", "private, no-cache");
    return source;
  }

  @Delete("import-sources/:sourceId")
  @HttpCode(204)
  delete(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("sourceId") sourceId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.sources.delete(principal.id, sourceId, parseIfMatch(ifMatch));
  }
}

function parseLimit(value?: string) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}
