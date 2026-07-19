import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import {
  createProjectRequestSchema,
  duplicateProjectRequestSchema,
  projectRelationshipSchema,
  setProjectMemberRoleRequestSchema,
  updateProjectRequestSchema,
  type CreateProjectRequest,
  type DuplicateProjectRequest,
  type SetProjectMemberRoleRequest,
  type UpdateProjectRequest,
} from "@workbench/workbench-contracts";
import { parseIfMatch, revisionEtag } from "../../common/http-preconditions.js";
import { validationProblem } from "../../common/problem-details.js";
import { ZodValidationPipe } from "../../common/zod-validation.pipe.js";
import { CurrentPrincipal } from "../identity/current-principal.decorator.js";
import type { AuthenticatedPrincipal } from "../identity/identity.types.js";
import { WorkbenchAuthGuard } from "../identity/workbench-auth.guard.js";
import { ProjectDuplicatesService } from "./project-duplicates.service.js";
import { ProjectMembersService } from "./project-members.service.js";
import { ProjectsService } from "./projects.service.js";

@Controller()
@UseGuards(WorkbenchAuthGuard)
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly members: ProjectMembersService,
    private readonly duplicates: ProjectDuplicatesService,
  ) {}

  @Get("projects")
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query("q") query?: string | string[],
    @Query("relationship") relationship?: string | string[],
    @Query("cursor") cursor?: string | string[],
    @Query("limit") limit?: string | string[],
  ) {
    return this.projects.list(
      principal.id,
      singleQueryValue("q", query),
      parseRelationship(relationship),
      singleQueryValue("cursor", cursor),
      parseLimit(limit),
    );
  }

  @Delete("projects/:projectId")
  async archive(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const project = await this.projects.archive(
      principal.id,
      projectId,
      parseIfMatch(ifMatch),
    );
    response.setHeader("ETag", revisionEtag(project.revision));
    return project;
  }

  @Post("projects/:projectId/duplicate")
  async duplicate(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(duplicateProjectRequestSchema)) body: DuplicateProjectRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!idempotencyKey) throw validationProblem("Idempotency-Key is required");
    const duplicate = await this.duplicates.create(
      principal.id,
      projectId,
      idempotencyKey,
      body,
    );
    response.setHeader("ETag", revisionEtag(duplicate.project.revision));
    response.setHeader("Location", `/api/v1/projects/${duplicate.project.id}/bootstrap`);
    return duplicate;
  }

  @Get("projects/:projectId/members")
  listMembers(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
  ) {
    return this.members.list(principal.id, projectId);
  }

  @Put("projects/:projectId/members/:principalId")
  async setMemberRole(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Param("principalId") memberPrincipalId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body(new ZodValidationPipe(setProjectMemberRoleRequestSchema)) body: SetProjectMemberRoleRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.members.setRole(
      principal.id,
      projectId,
      memberPrincipalId,
      parseIfMatch(ifMatch),
      body.role,
    );
    response.setHeader("ETag", revisionEtag(result.projectRevision));
    return result.member;
  }

  @Delete("projects/:projectId/members/:principalId")
  @HttpCode(204)
  async removeMember(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Param("principalId") memberPrincipalId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const revision = await this.members.remove(
      principal.id,
      projectId,
      memberPrincipalId,
      parseIfMatch(ifMatch),
    );
    response.setHeader("ETag", revisionEtag(revision));
  }

  @Post("workspaces/:workspaceId/projects")
  async create(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("workspaceId") workspaceId: string,
    @Body(new ZodValidationPipe(createProjectRequestSchema)) body: CreateProjectRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const project = await this.projects.create(principal.id, workspaceId, body);
    response.setHeader("ETag", revisionEtag(project.revision));
    response.setHeader("Location", `/api/v1/projects/${project.id}/bootstrap`);
    return project;
  }

  @Patch("projects/:projectId")
  async update(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body(new ZodValidationPipe(updateProjectRequestSchema)) body: UpdateProjectRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const project = await this.projects.update(principal.id, projectId, parseIfMatch(ifMatch), body);
    response.setHeader("ETag", revisionEtag(project.revision));
    return project;
  }

  @Get("projects/:projectId/bootstrap")
  async bootstrap(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param("projectId") projectId: string,
    @Query("threadId") threadId: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const bootstrap = await this.projects.bootstrap(principal.id, projectId, threadId);
    response.setHeader("ETag", revisionEtag(bootstrap.project.revision));
    return bootstrap;
  }
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

function parseRelationship(value?: string | string[]) {
  value = singleQueryValue("relationship", value);
  if (value === undefined || value === "") return undefined;
  const parsed = projectRelationshipSchema.safeParse(value);
  if (!parsed.success) throw validationProblem("relationship must be owned or shared");
  return parsed.data;
}

function singleQueryValue(name: string, value?: string | string[]) {
  if (Array.isArray(value)) throw validationProblem(`${name} must be provided at most once`);
  return value;
}
