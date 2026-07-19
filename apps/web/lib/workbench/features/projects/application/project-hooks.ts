"use client";

import type {
  CreateProjectInvitationRequest,
  CreateProjectRequest,
  ProjectBootstrap,
  SetProjectMemberRoleRequest,
  UpdateProjectRequest,
} from "@workbench/workbench-contracts";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { isWorkbenchApiError } from "../../../api/problem-details";
import { workbenchQueryKeys } from "../../../query/keys";
import {
  WorkbenchVersionRequiredError,
  type Versioned,
} from "../../../transport/contracts";
import { useWorkbenchProjectsApi } from "../api-adapter";
import type {
  ProjectInvitationListOptions,
  ProjectListOptions,
  WorkspaceMemberListOptions,
} from "../domain";
import { projectInvitationTokenScope } from "../domain";

export function useInfiniteWorkbenchWorkspaceMembers(
  workspaceId: string,
  options: Omit<WorkspaceMemberListOptions, "cursor"> = {},
) {
  const api = useWorkbenchProjectsApi();
  return useInfiniteQuery({
    queryKey: workbenchQueryKeys.workspaceMemberInfiniteList(workspaceId, options),
    queryFn: ({ pageParam }) => api.listWorkspaceMembers(workspaceId, {
      ...options,
      cursor: pageParam,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(workspaceId),
  });
}

export function useWorkbenchProjects(options: ProjectListOptions = {}) {
  const api = useWorkbenchProjectsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.projectList(options),
    queryFn: () => api.listProjects(options),
    placeholderData: keepPreviousData,
  });
}

export function useInfiniteWorkbenchProjects(
  options: Omit<ProjectListOptions, "cursor"> = {},
) {
  const api = useWorkbenchProjectsApi();
  return useInfiniteQuery({
    queryKey: workbenchQueryKeys.projectInfiniteList(options),
    queryFn: ({ pageParam }) => api.listProjects({
      ...options,
      cursor: pageParam,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
}

export function useCreateWorkbenchProject(workspaceId: string) {
  const api = useWorkbenchProjectsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateProjectRequest) => api.createProject(workspaceId, request),
    async onSuccess() {
      await queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.projectLists() });
    },
  });
}

export function useWorkbenchProjectBootstrap(projectId: string, threadId?: string) {
  const api = useWorkbenchProjectsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.bootstrap(projectId, threadId),
    queryFn: () => api.getProjectBootstrap(projectId, threadId),
    enabled: Boolean(projectId),
  });
}

export function useUpdateWorkbenchProject(projectId: string) {
  const api = useWorkbenchProjectsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.project(projectId), "update"],
    mutationFn: async ({
      request,
      ifMatch,
    }: {
      request: UpdateProjectRequest;
      ifMatch?: string;
    }) => {
      const etag = ifMatch ?? cachedProjectEtag(queryClient, projectId);
      if (!etag) throw new WorkbenchVersionRequiredError("project", projectId);
      return api.updateProject(projectId, request, etag);
    },
    async onSuccess(result) {
      queryClient.setQueriesData<Versioned<ProjectBootstrap>>(
        { queryKey: workbenchQueryKeys.bootstraps(projectId) },
        (current) => current
          ? { value: { ...current.value, project: result.value }, etag: result.etag }
          : current,
      );
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.projectLists(),
      });
    },
  });
}

export function useDuplicateWorkbenchProject(projectId: string) {
  const api = useWorkbenchProjectsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.project(projectId), "duplicate"],
    mutationFn: ({
      projectId: requestedProjectId,
      title,
      idempotencyKey,
    }: {
      projectId?: string;
      title?: string;
      idempotencyKey?: string;
    } = {}) => {
      const targetProjectId = requestedProjectId ?? projectId;
      if (!targetProjectId) throw new Error("Select a Project before duplicating it");
      return api.duplicateProject(
        targetProjectId,
        title === undefined ? {} : { title },
        idempotencyKey,
      );
    },
    async onSuccess() {
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.projectLists(),
      });
    },
  });
}

export function useArchiveWorkbenchProject(projectId: string) {
  const api = useWorkbenchProjectsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...workbenchQueryKeys.project(projectId), "archive"],
    mutationFn: ({
      projectId: requestedProjectId,
      ifMatch,
    }: {
      projectId?: string;
      ifMatch?: string;
    } = {}) => {
      const targetProjectId = requestedProjectId ?? projectId;
      if (!targetProjectId) throw new Error("Select a Project before archiving it");
      const etag = ifMatch ?? cachedProjectEtag(queryClient, targetProjectId);
      if (!etag) throw new WorkbenchVersionRequiredError("project", targetProjectId);
      return api.archiveProject(targetProjectId, etag);
    },
    async onSuccess(result, variables) {
      const targetProjectId = variables.projectId ?? projectId;
      queryClient.removeQueries({ queryKey: workbenchQueryKeys.project(targetProjectId) });
      await queryClient.invalidateQueries({
        queryKey: workbenchQueryKeys.projectLists(),
      });
    },
    async onError(error, variables) {
      if (!isWorkbenchApiError(error) || error.status !== 412) return;
      const targetProjectId = variables.projectId ?? projectId;
      await Promise.all([
        queryClient.refetchQueries({
          queryKey: workbenchQueryKeys.bootstraps(targetProjectId),
          type: "all",
        }),
        queryClient.refetchQueries({
          predicate: (query) => (
            query.queryKey[0] === "workbench"
            && query.queryKey[1] === "projects"
            && query.queryKey[2] === "list"
          ),
          type: "all",
        }),
      ]);
    },
  });
}

export function useWorkbenchProjectMembers(projectId: string) {
  const api = useWorkbenchProjectsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.projectMembers(projectId),
    queryFn: () => api.listProjectMembers(projectId),
    enabled: Boolean(projectId),
  });
}

export function useInfiniteWorkbenchProjectInvitations(
  projectId: string,
  options: Omit<ProjectInvitationListOptions, "cursor"> = {},
) {
  const api = useWorkbenchProjectsApi();
  return useInfiniteQuery({
    queryKey: workbenchQueryKeys.projectInvitationInfiniteList(projectId, options),
    queryFn: ({ pageParam }) => api.listProjectInvitations(projectId, {
      ...options,
      cursor: pageParam,
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: Boolean(projectId),
  });
}

export function useCreateWorkbenchProjectInvitation(projectId: string) {
  const api = useWorkbenchProjectsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      request,
      ifMatch,
      idempotencyKey,
    }: {
      request: CreateProjectInvitationRequest;
      ifMatch?: string;
      idempotencyKey?: string;
    }) => {
      const etag = ifMatch ?? cachedProjectEtag(queryClient, projectId);
      if (!etag) throw new WorkbenchVersionRequiredError("project", projectId);
      return api.createProjectInvitation(projectId, request, etag, idempotencyKey);
    },
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.projectInvitation(projectId, result.value.invitation.id),
        result.value,
      );
      await refreshProjectInvitationState(queryClient, projectId);
    },
    async onError(error) {
      if (!isWorkbenchApiError(error) || error.status !== 412) return;
      await refreshProjectInvitationState(queryClient, projectId, true);
    },
  });
}

export function useRevokeWorkbenchProjectInvitation(projectId: string) {
  const api = useWorkbenchProjectsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      invitationId,
      ifMatch,
    }: {
      invitationId: string;
      ifMatch?: string;
    }) => {
      const etag = ifMatch ?? cachedProjectEtag(queryClient, projectId);
      if (!etag) throw new WorkbenchVersionRequiredError("project", projectId);
      return api.revokeProjectInvitation(projectId, invitationId, etag);
    },
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.projectInvitation(projectId, result.value.id),
        result.value,
      );
      await refreshProjectInvitationState(queryClient, projectId);
    },
    async onError(error) {
      if (!isWorkbenchApiError(error) || error.status !== 412) return;
      await refreshProjectInvitationState(queryClient, projectId, true);
    },
  });
}

export function useWorkbenchProjectInvitationPreview(token: string) {
  const api = useWorkbenchProjectsApi();
  return useQuery({
    queryKey: workbenchQueryKeys.projectInvitationPreview(
      token ? projectInvitationTokenScope(token) : "disabled",
    ),
    queryFn: () => api.previewProjectInvitation(token),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useAcceptWorkbenchProjectInvitation() {
  const api = useWorkbenchProjectsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.acceptProjectInvitation(token),
    async onSuccess(result) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.identity() }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.projects() }),
        queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.projectInvitations(result.value.invitation.projectId),
        }),
      ]);
    },
  });
}

export function useSetWorkbenchProjectMemberRole(projectId: string) {
  const api = useWorkbenchProjectsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      principalId,
      request,
      ifMatch,
    }: {
      principalId: string;
      request: SetProjectMemberRoleRequest;
      ifMatch?: string;
    }) => {
      const etag = ifMatch ?? cachedProjectEtag(queryClient, projectId);
      if (!etag) throw new WorkbenchVersionRequiredError("project", projectId);
      return api.setProjectMemberRole(projectId, principalId, request, etag);
    },
    async onSuccess(result) {
      queryClient.setQueryData(
        workbenchQueryKeys.projectMember(projectId, result.value.principalId),
        result.value,
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.projectMembers(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.projects() }),
      ]);
    },
    async onError(error) {
      if (!isWorkbenchApiError(error) || error.status !== 412) return;
      await refetchProjectMembershipAfterConflict(queryClient, projectId);
    },
  });
}

export function useRemoveWorkbenchProjectMember(projectId: string) {
  const api = useWorkbenchProjectsApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ principalId, ifMatch }: { principalId: string; ifMatch?: string }) => {
      const etag = ifMatch ?? cachedProjectEtag(queryClient, projectId);
      if (!etag) throw new WorkbenchVersionRequiredError("project", projectId);
      return api.removeProjectMember(projectId, principalId, etag);
    },
    async onSuccess(_, variables) {
      queryClient.removeQueries({
        queryKey: workbenchQueryKeys.projectMember(projectId, variables.principalId),
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.projectMembers(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) }),
        queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.projects() }),
      ]);
    },
    async onError(error) {
      if (!isWorkbenchApiError(error) || error.status !== 412) return;
      await refetchProjectMembershipAfterConflict(queryClient, projectId);
    },
  });
}

async function refetchProjectMembershipAfterConflict(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
) {
  await Promise.all([
    queryClient.refetchQueries({
      queryKey: workbenchQueryKeys.bootstraps(projectId),
      type: "all",
    }),
    queryClient.refetchQueries({
      queryKey: workbenchQueryKeys.projectMembers(projectId),
      exact: true,
      type: "all",
    }),
  ]);
}

async function refreshProjectInvitationState(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  refetch = false,
) {
  const method = refetch ? queryClient.refetchQueries.bind(queryClient) : queryClient.invalidateQueries.bind(queryClient);
  await Promise.all([
    method({ queryKey: workbenchQueryKeys.bootstraps(projectId), type: "all" }),
    method({ queryKey: workbenchQueryKeys.projectInvitations(projectId), type: "all" }),
    method({ queryKey: workbenchQueryKeys.projects(), type: "all" }),
  ]);
}

function cachedProjectEtag(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
): string | undefined {
  return queryClient
    .getQueriesData<Versioned<ProjectBootstrap>>({
      queryKey: workbenchQueryKeys.bootstraps(projectId),
    })
    .reduce<Versioned<ProjectBootstrap> | undefined>((latest, [, candidate]) => {
      if (!candidate) return latest;
      return !latest || candidate.value.project.revision > latest.value.project.revision
        ? candidate
        : latest;
    }, undefined)
    ?.etag;
}
