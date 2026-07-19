import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  createSubmissionIntentRequestSchema,
  type CreateSubmissionIntentRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { SubmissionIntentsService } from "./submission-intents.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class SubmissionIntentsController {
  constructor(private readonly intents: SubmissionIntentsService) {}

  @Post("threads/:threadId/submission-intents")
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("threadId") threadId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createSubmissionIntentRequestSchema))
    body: CreateSubmissionIntentRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const intent = await this.intents.create(principal.id, threadId, idempotencyKey, body);
    response.setHeader("ETag", revisionEtag(intent.revision));
    response.setHeader("Location", `/api/v1/submission-intents/${intent.id}`);
    return intent;
  }

  @Get("threads/:threadId/submission-intents/current")
  current(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("threadId") threadId: string,
  ) {
    return this.intents.current(principal.id, threadId);
  }

  @Get("submission-intents/:intentId")
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("intentId") intentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const intent = await this.intents.get(principal.id, intentId);
    response.setHeader("ETag", revisionEtag(intent.revision));
    return intent;
  }

  @Post("submission-intents/:intentId/submit")
  @HttpCode(202)
  async submit(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("intentId") intentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const receipt = await this.intents.submit(principal.id, intentId);
    response.setHeader("ETag", revisionEtag(receipt.intent.revision));
    response.setHeader("Location", `/api/v1/runs/${receipt.run.id}`);
    return receipt;
  }

  @Delete("submission-intents/:intentId")
  @HttpCode(204)
  cancel(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("intentId") intentId: string,
    @Headers("if-match") ifMatch: string | undefined,
  ) {
    return this.intents.cancel(principal.id, intentId, parseIfMatch(ifMatch));
  }
}
