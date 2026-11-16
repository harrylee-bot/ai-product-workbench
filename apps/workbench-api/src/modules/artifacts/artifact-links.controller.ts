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
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  artifactLinksQuerySchema,
  createArtifactLinkRequestSchema,
  type CreateArtifactLinkRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { ArtifactLinksService } from "./artifact-links.service.js";
@Controller("projects/:projectId/artifact-links")
@UseGuards(WorkbenchAuthGuard)
export class ArtifactLinksController {
  constructor(private readonly links: ArtifactLinksService) {}
  @Get()
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query(new ZodValidationPipe(artifactLinksQuerySchema)) query: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return this.links.list(principal.id, projectId, query);
  }
  @Post()
  @HttpCode(201)
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body(new ZodValidationPipe(createArtifactLinkRequestSchema))
    body: CreateArtifactLinkRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!key) throw validationProblem("Idempotency-Key is required");
    const result = await this.links.create(principal.id, projectId, key, body);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }
  @Post(":linkId/remove")
  @HttpCode(200)
  async remove(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Param("linkId") linkId: string,
    @Headers("if-match") etag: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.links.remove(
      principal.id,
      projectId,
      linkId,
      parseIfMatch(etag),
    );
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }
}
