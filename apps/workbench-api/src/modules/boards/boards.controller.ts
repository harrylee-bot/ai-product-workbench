import { Body, Controller, Get, Headers, Param, Put, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  replaceBoardRequestSchema,
  type ReplaceBoardRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { BoardsService } from "./boards.service.js";

@Controller("projects/:projectId/board")
@UseGuards(WorkbenchAuthGuard)
export class BoardsController {
  constructor(private readonly boards: BoardsService) {}

  @Get()
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const board = await this.boards.get(principal.id, projectId);
    response.setHeader("ETag", revisionEtag(board.revision));
    return board;
  }

  @Put()
  async replace(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(replaceBoardRequestSchema)) body: ReplaceBoardRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const board = await this.boards.replace(
      principal.id,
      projectId,
      parseIfMatch(ifMatch),
      idempotencyKey,
      body,
    );
    response.setHeader("ETag", revisionEtag(board.revision));
    return board;
  }
}
