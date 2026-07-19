import { Body, Controller, Get, Headers, HttpCode, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import {
  submitApprovalRequestSchema,
  type SubmitApprovalRequest,
} from "@workbench/workbench-contracts";
import { revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { RunApprovalsService } from "./run-approvals.service.js";

@Controller("runs/:runId/approvals")
@UseGuards(WorkbenchAuthGuard)
export class RunApprovalsController {
  constructor(private readonly approvals: RunApprovalsService) {}

  @Get()
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("runId") runId: string,
  ) {
    return this.approvals.list(principal.id, runId);
  }

  @Get(":approvalId")
  async get(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("runId") runId: string,
    @Param("approvalId") approvalId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const approval = await this.approvals.get(principal.id, runId, approvalId);
    response.setHeader("ETag", revisionEtag(approval.revision));
    return approval;
  }

  @Post(":approvalId")
  @HttpCode(202)
  async submit(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("runId") runId: string,
    @Param("approvalId") approvalId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(submitApprovalRequestSchema)) body: SubmitApprovalRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const result = await this.approvals.submit(principal.id, runId, approvalId, idempotencyKey, body);
    response.setHeader("ETag", revisionEtag(result.approval.revision));
    response.setHeader("Location", `/api/v1/runs/${runId}`);
    return result;
  }
}
