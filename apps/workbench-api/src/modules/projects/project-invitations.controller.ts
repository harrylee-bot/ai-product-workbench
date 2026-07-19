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
  createProjectInvitationRequestSchema,
  projectInvitationStatusSchema,
  projectInvitationTokenRequestSchema,
  type CreateProjectInvitationRequest,
  type ProjectInvitationTokenRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { ProjectInvitationsService } from "./project-invitations.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class ProjectInvitationsController {
  constructor(private readonly invitations: ProjectInvitationsService) {}

  @Get("projects/:projectId/invitations")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ) {
    assertKnownListQueryFields(query);
    return this.invitations.list(
      principal.id,
      projectId,
      parseStatus(query.status),
      parseCursor(query.cursor),
      parseLimit(query.limit),
    );
  }

  @Post("projects/:projectId/invitations")
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(createProjectInvitationRequestSchema))
    body: CreateProjectInvitationRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const result = await this.invitations.create(
      principal.id,
      projectId,
      parseIfMatch(ifMatch),
      idempotencyKey,
      body,
    );
    response.setHeader("ETag", revisionEtag(result.projectRevision));
    return result.response;
  }

  @Delete("projects/:projectId/invitations/:invitationId")
  async revoke(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Param("invitationId") invitationId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.invitations.revoke(
      principal.id,
      projectId,
      invitationId,
      parseIfMatch(ifMatch),
    );
    response.setHeader("ETag", revisionEtag(result.projectRevision));
    return result.invitation;
  }

  @Post("project-invitations/preview")
  @HttpCode(200)
  preview(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(projectInvitationTokenRequestSchema))
    body: ProjectInvitationTokenRequest,
  ) {
    return this.invitations.preview(principal, body.token);
  }

  @Post("project-invitations/accept")
  @HttpCode(200)
  async accept(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(projectInvitationTokenRequestSchema))
    body: ProjectInvitationTokenRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.invitations.accept(principal, body.token);
    response.setHeader("ETag", revisionEtag(result.projectRevision));
    response.setHeader(
      "Location",
      `/api/v1/projects/${result.response.invitation.projectId}/bootstrap`,
    );
    return result.response;
  }
}

function assertKnownListQueryFields(query: Record<string, unknown>) {
  const unknown = Object.keys(query).filter((key) => !["status", "cursor", "limit"].includes(key));
  if (unknown.length > 0) {
    throw validationProblem(`Unknown Project invitation query field: ${unknown[0]}`);
  }
}

function parseStatus(value?: string | string[]) {
  value = singleQueryValue("status", value);
  if (value === undefined || value === "") return undefined;
  const parsed = projectInvitationStatusSchema.safeParse(value);
  if (!parsed.success) throw validationProblem("status must be pending, accepted, revoked, or expired");
  return parsed.data;
}

function parseCursor(value?: string | string[]) {
  value = singleQueryValue("cursor", value);
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 2_048) {
    throw validationProblem("cursor must contain between 1 and 2048 characters");
  }
  return value;
}

function parseLimit(value?: string | string[]) {
  value = singleQueryValue("limit", value);
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw validationProblem("limit must be an integer between 1 and 100");
  }
  return parsed;
}

function singleQueryValue(name: string, value?: string | string[]) {
  if (Array.isArray(value)) throw validationProblem(`${name} must be provided at most once`);
  return value;
}
