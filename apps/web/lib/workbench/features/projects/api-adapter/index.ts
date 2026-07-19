"use client";

import {
  acceptProjectInvitationResponseSchema,
  createProjectInvitationRequestSchema,
  createProjectInvitationResponseSchema,
  projectBootstrapSchema,
  projectDuplicateSchema,
  projectInvitationListSchema,
  projectInvitationPreviewSchema,
  projectInvitationSchema,
  projectInvitationTokenRequestSchema,
  projectListSchema,
  projectMemberListSchema,
  projectMemberSchema,
  projectSchema,
  workspaceMemberListSchema,
  type AcceptProjectInvitationResponse,
  type CreateProjectInvitationRequest,
  type CreateProjectInvitationResponse,
  type CreateProjectRequest,
  type Project,
  type ProjectBootstrap,
  type ProjectDuplicate,
  type ProjectInvitation,
  type ProjectInvitationList,
  type ProjectInvitationPreview,
  type ProjectList,
  type ProjectMember,
  type ProjectMemberList,
  type SetProjectMemberRoleRequest,
  type UpdateProjectRequest,
  type WorkspaceMemberList,
} from "@workbench/workbench-contracts";
import { useMemo } from "react";

import type { WorkbenchApiClient } from "../../../api/client";
import { useWorkbenchTransport } from "../../../transport/context";
import {
  createIdempotencyKey,
  normalizeEtag,
  normalizeIdempotencyKey,
  parseContract,
  responseEtag,
  versioned,
  type Versioned,
} from "../../../transport/contracts";
import type {
  ProjectInvitationListOptions,
  ProjectListOptions,
  WorkspaceMemberListOptions,
} from "../domain";

export class WorkbenchProjectsApi {
  constructor(private readonly api: WorkbenchApiClient) {}

  async listProjects(options: ProjectListOptions = {}): Promise<ProjectList> {
    const result = await this.api.GET("/projects", {
      params: { query: options },
    });
    return parseContract(projectListSchema, result.data, "list projects");
  }

  async listWorkspaceMembers(
    workspaceId: string,
    options: WorkspaceMemberListOptions = {},
  ): Promise<WorkspaceMemberList> {
    const result = await this.api.GET("/workspaces/{workspaceId}/members", {
      params: { path: { workspaceId }, query: options },
    });
    return parseContract(
      workspaceMemberListSchema,
      result.data,
      "list Workspace members",
    );
  }

  async createProject(
    workspaceId: string,
    request: CreateProjectRequest,
  ): Promise<Versioned<Project>> {
    const result = await this.api.POST("/workspaces/{workspaceId}/projects", {
      params: { path: { workspaceId } },
      body: request,
    });
    return versioned(projectSchema, result.data, result.response, "create project");
  }

  async updateProject(
    projectId: string,
    request: UpdateProjectRequest,
    ifMatch: string,
  ): Promise<Versioned<Project>> {
    const result = await this.api.PATCH("/projects/{projectId}", {
      params: {
        path: { projectId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
      body: request,
    });
    return versioned(projectSchema, result.data, result.response, "update project");
  }

  async archiveProject(
    projectId: string,
    ifMatch: string,
  ): Promise<Versioned<Project>> {
    const result = await this.api.DELETE("/projects/{projectId}", {
      params: {
        path: { projectId },
        header: { "If-Match": normalizeEtag(ifMatch) },
      },
    });
    return versioned(projectSchema, result.data, result.response, "archive project");
  }

  async duplicateProject(
    projectId: string,
    request: { title?: string } = {},
    idempotencyKey = createIdempotencyKey("project-duplicate"),
  ): Promise<Versioned<ProjectDuplicate>> {
    const result = await this.api.POST("/projects/{projectId}/duplicate", {
      params: {
        path: { projectId },
        header: { "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey) },
      },
      body: request,
    });
    return versioned(
      projectDuplicateSchema,
      result.data,
      result.response,
      "duplicate project",
    );
  }

  async listProjectMembers(projectId: string): Promise<ProjectMemberList> {
    const result = await this.api.GET("/projects/{projectId}/members", {
      params: { path: { projectId } },
    });
    return parseContract(
      projectMemberListSchema,
      result.data,
      "list project members",
    );
  }

  async listProjectInvitations(
    projectId: string,
    options: ProjectInvitationListOptions = {},
  ): Promise<ProjectInvitationList> {
    const result = await this.api.GET("/projects/{projectId}/invitations", {
      params: { path: { projectId }, query: options },
    });
    return parseContract(
      projectInvitationListSchema,
      result.data,
      "list Project invitations",
    );
  }

  async createProjectInvitation(
    projectId: string,
    request: CreateProjectInvitationRequest,
    ifMatch: string,
    idempotencyKey = createIdempotencyKey("project-invitation"),
  ): Promise<Versioned<CreateProjectInvitationResponse>> {
    const result = await this.api.POST("/projects/{projectId}/invitations", {
      params: {
        path: { projectId },
        header: {
          "If-Match": normalizeEtag(ifMatch),
          "Idempotency-Key": normalizeIdempotencyKey(idempotencyKey),
        },
      },
      body: createProjectInvitationRequestSchema.parse(request),
    });
    return versioned(
      createProjectInvitationResponseSchema,
      result.data,
      result.response,
      "create Project invitation",
    );
  }

  async revokeProjectInvitation(
    projectId: string,
    invitationId: string,
    ifMatch: string,
  ): Promise<Versioned<ProjectInvitation>> {
    const result = await this.api.DELETE(
      "/projects/{projectId}/invitations/{invitationId}",
      {
        params: {
          path: { projectId, invitationId },
          header: { "If-Match": normalizeEtag(ifMatch) },
        },
      },
    );
    return versioned(
      projectInvitationSchema,
      result.data,
      result.response,
      "revoke Project invitation",
    );
  }

  async previewProjectInvitation(token: string): Promise<ProjectInvitationPreview> {
    const result = await this.api.POST("/project-invitations/preview", {
      body: projectInvitationTokenRequestSchema.parse({ token }),
    });
    return parseContract(
      projectInvitationPreviewSchema,
      result.data,
      "preview Project invitation",
    );
  }

  async acceptProjectInvitation(
    token: string,
  ): Promise<Versioned<AcceptProjectInvitationResponse>> {
    const result = await this.api.POST("/project-invitations/accept", {
      body: projectInvitationTokenRequestSchema.parse({ token }),
    });
    return versioned(
      acceptProjectInvitationResponseSchema,
      result.data,
      result.response,
      "accept Project invitation",
    );
  }

  async setProjectMemberRole(
    projectId: string,
    principalId: string,
    request: SetProjectMemberRoleRequest,
    ifMatch: string,
  ): Promise<Versioned<ProjectMember>> {
    const result = await this.api.PUT(
      "/projects/{projectId}/members/{principalId}",
      {
        params: {
          path: { projectId, principalId },
          header: { "If-Match": normalizeEtag(ifMatch) },
        },
        body: request,
      },
    );
    return versioned(
      projectMemberSchema,
      result.data,
      result.response,
      "set project member role",
    );
  }

  async removeProjectMember(
    projectId: string,
    principalId: string,
    ifMatch: string,
  ): Promise<{ etag: string }> {
    const result = await this.api.DELETE(
      "/projects/{projectId}/members/{principalId}",
      {
        params: {
          path: { projectId, principalId },
          header: { "If-Match": normalizeEtag(ifMatch) },
        },
      },
    );
    return { etag: responseEtag(result.response, "remove project member") };
  }

  async getProjectBootstrap(
    projectId: string,
    threadId?: string,
  ): Promise<Versioned<ProjectBootstrap>> {
    const result = await this.api.GET("/projects/{projectId}/bootstrap", {
      params: {
        path: { projectId },
        query: threadId === undefined ? {} : { threadId },
      },
    });
    return versioned(
      projectBootstrapSchema,
      result.data,
      result.response,
      "get project bootstrap",
    );
  }
}

export function useWorkbenchProjectsApi(): WorkbenchProjectsApi {
  const { api } = useWorkbenchTransport();
  return useMemo(() => new WorkbenchProjectsApi(api), [api]);
}
