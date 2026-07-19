import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  createThreadRequestSchema,
  updateThreadRequestSchema,
  type CreateThreadRequest,
  type UpdateThreadRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { ThreadsService } from "./threads.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @Get("projects/:projectId/threads")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.threads.list(principal.id, projectId, cursor, parseLimit(limit, 100));
  }

  @Post("projects/:projectId/threads")
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createThreadRequestSchema)) body: CreateThreadRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const thread = await this.threads.create(principal.id, projectId, idempotencyKey, body);
    response.setHeader("ETag", revisionEtag(thread.revision));
    response.setHeader("Location", `/api/v1/threads/${thread.id}`);
    return thread;
  }

  @Get("threads/:threadId")
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("threadId") threadId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const thread = await this.threads.get(principal.id, threadId);
    response.setHeader("ETag", revisionEtag(thread.revision));
    return thread;
  }

  @Patch("threads/:threadId")
  async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("threadId") threadId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body(new ZodValidationPipe(updateThreadRequestSchema)) body: UpdateThreadRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const thread = await this.threads.update(principal.id, threadId, parseIfMatch(ifMatch), body);
    response.setHeader("ETag", revisionEtag(thread.revision));
    return thread;
  }

  @Delete("threads/:threadId")
  @HttpCode(204)
  archive(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("threadId") threadId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.threads.archive(principal.id, threadId, parseIfMatch(ifMatch));
  }

  @Get("threads/:threadId/entries")
  entries(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("threadId") threadId: string,
    @Query("afterSequence") afterSequence?: string,
    @Query("limit") limit?: string,
  ) {
    return this.threads.listEntries(
      principal.id,
      threadId,
      parseAfterSequence(afterSequence),
      parseLimit(limit, 500),
    );
  }
}

export function parseAfterSequence(value?: string) {
  if (value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw validationProblem("afterSequence must be a non-negative integer");
  }
  return parsed;
}

export function parseLimit(value: string | undefined, maximum: number) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw validationProblem(`limit must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}
