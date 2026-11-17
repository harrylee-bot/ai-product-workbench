import { Controller, Get, Query, HttpCode, Headers, Param, Post, Body, Res, StreamableFile, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import {
  prototypeFeedbackLocationsQuerySchema, prototypeFeedbackQuerySchema,
  createPrototypeExportRequestSchema,
  createPrototypeFeedbackRequestSchema,
  createPrototypeShareRequestSchema,
  prototypeWorkflowActionRequestSchema,
} from "@workbench/workbench-contracts";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { validationProblem } from "../../common/problem-details.js";
import { revisionEtag } from "../../common/http-preconditions.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { PrototypeV2Service } from "./prototype-v2.service.js";

const body = <T>(schema: z.ZodType<T>) => new ZodValidationPipe(schema);
function requireHeader(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw validationProblem(`${name} is required`);
  if (name === "Idempotency-Key" && (normalized.length < 8 || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(normalized))) {
    throw validationProblem("Idempotency-Key is invalid");
  }
  return normalized;
}

@Controller("projects/:projectId/prototype-v2")
@UseGuards(WorkbenchAuthGuard)
export class PrototypeV2Controller {
  constructor(private readonly service: PrototypeV2Service) {}

  @Get("plans")
  listPlans(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string) { return this.service.listPlans(principal, projectId); }

  @Get("revisions/:revisionId")
  async getRevision(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("revisionId") revisionId: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.getRevision(principal, projectId, revisionId);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Get("revisions/:revisionId/feedback-locations")
  async feedbackLocations(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("revisionId") revisionId: string, @Query(body(prototypeFeedbackLocationsQuerySchema)) query: z.infer<typeof prototypeFeedbackLocationsQuerySchema>, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "private, no-store");
    const {sourceRevisionId,...pagination}=query;
    return this.service.feedbackLocations(principal, projectId, sourceRevisionId, revisionId, pagination);
  }

  @Get("revisions/:revisionId/relations")
  revisionRelations(@CurrentPrincipal() principal: AuthenticatedPrincipal,@Param("projectId") projectId:string,@Param("revisionId") revisionId:string,@Res({passthrough:true}) response:Response){
    response.setHeader("Cache-Control","private, no-store");
    return this.service.revisionRelations(principal,projectId,revisionId);
  }

  @Get("revisions/:revisionId/feedback")
  listFeedback(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("revisionId") revisionId: string, @Query(body(prototypeFeedbackQuerySchema)) query: z.infer<typeof prototypeFeedbackQuerySchema>, @Res({ passthrough: true }) response: Response) { response.setHeader("Cache-Control", "private, no-store"); return this.service.listFeedback(principal, projectId, revisionId, query); }

  @Get("shares")
  listShares(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string) { return this.service.listShares(principal, projectId); }

  @Get("exports")
  listExports(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string) { return this.service.listExports(principal, projectId); }

  @Get("revisions/:revisionId/diff")
  getRevisionDiff(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("revisionId") revisionId: string) { return this.service.getRevisionDiff(principal, projectId, revisionId); }

  @Post("plans/:planId/retry")
  @HttpCode(202)
  async retryPlan(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("planId") planId: string, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Body(body(prototypeWorkflowActionRequestSchema)) request: z.infer<typeof prototypeWorkflowActionRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.retryPlan(principal, projectId, planId, requireHeader(key, "Idempotency-Key"), ifMatch, request);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Get("plans/:planId")
  async getPlan(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("planId") planId: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.getPlanSnapshot(principal, projectId, planId);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Get("plans/:planId/input")
  async getPlanInput(@CurrentPrincipal() principal:AuthenticatedPrincipal,@Param("projectId") projectId:string,@Param("planId") planId:string,@Res({passthrough:true}) response:Response){
    response.setHeader("Cache-Control","private, no-store");const value=await this.service.getPlanInput(principal,projectId,planId);response.setHeader("ETag",revisionEtag(value.plan.revision));return value;
  }
  @Get("revisions/:revisionId/input")
  async getRevisionInput(@CurrentPrincipal() principal:AuthenticatedPrincipal,@Param("projectId") projectId:string,@Param("revisionId") revisionId:string,@Res({passthrough:true}) response:Response){
    response.setHeader("Cache-Control","private, no-store");return this.service.getRevisionInput(principal,projectId,revisionId);
  }
  @Get("plans/:planId/progress")
  getProgress(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("planId") planId: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "private, no-store");
    return this.service.getProgress(principal, projectId, planId);
  }

  @Get("plans/:planId/revisions")
  listRevisions(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("planId") planId: string) {
    return this.service.listRevisions(principal, projectId, planId);
  }

  @Post("plans/:planId/cancel")
  @HttpCode(202)
  async cancelPlan(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("planId") planId: string, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Body(body(prototypeWorkflowActionRequestSchema)) request: z.infer<typeof prototypeWorkflowActionRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.cancelPlan(principal, projectId, planId, requireHeader(key, "Idempotency-Key"), ifMatch, request);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Post("revisions/:revisionId/confirm")
  async confirmRevision(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("revisionId") revisionId: string, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Body(body(prototypeWorkflowActionRequestSchema)) request: z.infer<typeof prototypeWorkflowActionRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.confirmRevision(principal, projectId, revisionId, requireHeader(key, "Idempotency-Key"), ifMatch, request);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Post("revisions/:revisionId/reject")
  async rejectRevision(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("revisionId") revisionId: string, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Body(body(prototypeWorkflowActionRequestSchema)) request: z.infer<typeof prototypeWorkflowActionRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.rejectRevision(principal, projectId, revisionId, requireHeader(key, "Idempotency-Key"), ifMatch, request);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Post("revisions/:revisionId/feedback")
  async createFeedback(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("revisionId") revisionId: string, @Headers("idempotency-key") key: string | undefined, @Body(body(createPrototypeFeedbackRequestSchema)) request: z.infer<typeof createPrototypeFeedbackRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.createFeedback(principal, projectId, revisionId, request, requireHeader(key, "Idempotency-Key"));
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Post("feedback/:feedbackId/resolve")
  async resolveFeedback(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("feedbackId") feedbackId: string, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Body(body(prototypeWorkflowActionRequestSchema)) request: z.infer<typeof prototypeWorkflowActionRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.resolveFeedback(principal, projectId, feedbackId, requireHeader(key, "Idempotency-Key"), ifMatch, request);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Post("shares")
  async createShare(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Headers("idempotency-key") key: string | undefined, @Body(body(createPrototypeShareRequestSchema)) request: z.infer<typeof createPrototypeShareRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.createShare(principal, projectId, request, requireHeader(key, "Idempotency-Key"));
    response.setHeader("ETag", revisionEtag(result.revision));
    response.setHeader("Location", result.url);
    return result;
  }

  @Post("shares/:shareId/revoke")
  async revokeShare(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("shareId") shareId: string, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Body(body(prototypeWorkflowActionRequestSchema)) request: z.infer<typeof prototypeWorkflowActionRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.revokeShare(principal, projectId, shareId, requireHeader(key, "Idempotency-Key"), ifMatch, request);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Post("revisions/:revisionId/preview-token")
  async createPreviewToken(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("revisionId") revisionId: string) {
    return this.service.createPreviewToken(principal, projectId, revisionId);
  }

  @Post("exports")
  async createExport(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Headers("idempotency-key") key: string | undefined, @Body(body(createPrototypeExportRequestSchema)) request: z.infer<typeof createPrototypeExportRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.createExport(principal, projectId, request, requireHeader(key, "Idempotency-Key"));
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Get("exports/:exportId")
  async getExport(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("exportId") exportId: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.getExport(principal, projectId, exportId);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Get("exports/:exportId/download")
  async downloadExport(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("exportId") exportId: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.getExportContent(principal, projectId, exportId);
    response.setHeader("Content-Type", result.mediaType);
    response.setHeader("Content-Length", String(result.byteSize));
    response.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    response.setHeader("Cache-Control", "private, no-store");
    return new StreamableFile(result.body);
  }

  @Post("exports/:exportId/retry")
  @HttpCode(202)
  async retryExport(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("exportId") exportId: string, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Body(body(prototypeWorkflowActionRequestSchema)) request: z.infer<typeof prototypeWorkflowActionRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.retryExport(principal, projectId, exportId, requireHeader(key, "Idempotency-Key"), ifMatch, request);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }

  @Post("exports/:exportId/cancel")
  @HttpCode(202)
  async cancelExport(@CurrentPrincipal() principal: AuthenticatedPrincipal, @Param("projectId") projectId: string, @Param("exportId") exportId: string, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Body(body(prototypeWorkflowActionRequestSchema)) request: z.infer<typeof prototypeWorkflowActionRequestSchema>, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.cancelExport(principal, projectId, exportId, requireHeader(key, "Idempotency-Key"), ifMatch, request);
    response.setHeader("ETag", revisionEtag(result.revision));
    return result;
  }
}

/** Anonymous read-only entry point used by the share URL returned by createShare. */
@Controller("public/prototype-v2")
export class PublicPrototypeV2Controller {
  constructor(private readonly service: PrototypeV2Service) {}

  @Get("shares/:token")
  async getShare(@Param("token") token: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.getPublicShare(token);
    response.setHeader("ETag", `"${result.revision.documentSha256}"`);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    return result;
  }

  @Get("previews/:token")
  async getPreview(@Param("token") token: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.service.getPreviewHtml(token);
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'self' data: blob:; form-action 'none'; sandbox allow-scripts");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    return result.html;
  }
}
