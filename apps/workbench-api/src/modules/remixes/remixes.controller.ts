import { Body, Controller, Headers, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  createProjectRemixRequestSchema,
  type CreateProjectRemixRequest,
} from "@workbench/workbench-contracts";
import { revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { RemixesService } from "./remixes.service.js";

@Controller("public/shares/:shareToken/remixes")
@UseGuards(WorkbenchAuthGuard)
export class RemixesController {
  constructor(private readonly remixes: RemixesService) {}

  @Post()
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("shareToken") shareToken: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createProjectRemixRequestSchema)) body: CreateProjectRemixRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const result = await this.remixes.create(principal.id, shareToken, idempotencyKey, body);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("ETag", revisionEtag(result.project.revision));
    response.setHeader("Location", `/api/v1/projects/${result.project.id}/bootstrap`);
    return result;
  }
}
