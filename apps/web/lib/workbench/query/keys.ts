export const workbenchQueryKeys = {
  all: ["workbench"] as const,
  identity: () => [...workbenchQueryKeys.all, "identity"] as const,
  communicationPreferences: () => [...workbenchQueryKeys.identity(), "preferences"] as const,
  runtimeModels: () => [...workbenchQueryKeys.all, "runtime", "models"] as const,
  exportCapabilities: () => [...workbenchQueryKeys.all, "exports", "capabilities"] as const,
  designSystems: () => [...workbenchQueryKeys.all, "design-systems"] as const,
  designPresets: () => [...workbenchQueryKeys.all, "design-presets"] as const,
  designSystemCatalogs: (workspaceId: string) =>
    [...workbenchQueryKeys.designSystems(), "catalog", workspaceId] as const,
  designSystemCatalog: (
    workspaceId: string,
    filters?: { cursor?: string; limit?: number; q?: string },
  ) => [...workbenchQueryKeys.designSystemCatalogs(workspaceId), filters ?? {}] as const,
  designSystemInfiniteCatalog: (
    workspaceId: string,
    filters?: { limit?: number; q?: string },
  ) => [...workbenchQueryKeys.designSystemCatalogs(workspaceId), "infinite", filters ?? {}] as const,
  workspaces: () => [...workbenchQueryKeys.all, "workspaces"] as const,
  workspace: (workspaceId: string) =>
    [...workbenchQueryKeys.workspaces(), workspaceId] as const,
  workspaceMemberLists: (workspaceId: string) =>
    [...workbenchQueryKeys.workspace(workspaceId), "members"] as const,
  workspaceMemberInfiniteList: (
    workspaceId: string,
    filters?: { limit?: number; q?: string },
  ) => [...workbenchQueryKeys.workspaceMemberLists(workspaceId), "infinite", filters ?? {}] as const,
  projects: () => [...workbenchQueryKeys.all, "projects"] as const,
  projectLists: () => [...workbenchQueryKeys.projects(), "list"] as const,
  projectList: (
    filters?: {
      cursor?: string;
      limit?: number;
      q?: string;
      relationship?: "owned" | "shared";
    },
  ) =>
    [...workbenchQueryKeys.projectLists(), filters ?? {}] as const,
  projectInfiniteList: (
    filters?: { limit?: number; q?: string; relationship?: "owned" | "shared" },
  ) => [...workbenchQueryKeys.projectLists(), "infinite", filters ?? {}] as const,
  project: (projectId: string) => [...workbenchQueryKeys.projects(), "detail", projectId] as const,
  projectMembers: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "members"] as const,
  projectMember: (projectId: string, principalId: string) =>
    [...workbenchQueryKeys.projectMembers(projectId), principalId] as const,
  projectInvitations: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "invitations"] as const,
  projectInvitationInfiniteList: (
    projectId: string,
    filters?: {
      limit?: number;
      status?: "pending" | "accepted" | "revoked" | "expired";
    },
  ) => [...workbenchQueryKeys.projectInvitations(projectId), "infinite", filters ?? {}] as const,
  projectInvitation: (projectId: string, invitationId: string) =>
    [...workbenchQueryKeys.projectInvitations(projectId), invitationId] as const,
  projectInvitationPreviews: () =>
    [...workbenchQueryKeys.all, "project-invitation-previews"] as const,
  projectInvitationPreview: (tokenScope: string) =>
    [...workbenchQueryKeys.projectInvitationPreviews(), tokenScope] as const,
  bootstraps: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "bootstrap"] as const,
  bootstrap: (projectId: string, threadId?: string) => threadId === undefined
    ? workbenchQueryKeys.bootstraps(projectId)
    : [...workbenchQueryKeys.bootstraps(projectId), threadId] as const,
  board: (projectId: string) => [...workbenchQueryKeys.project(projectId), "board"] as const,
  releases: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "releases"] as const,
  releaseLists: (projectId: string) =>
    [...workbenchQueryKeys.releases(projectId), "list"] as const,
  releaseList: (
    projectId: string,
    filters?: { cursor?: string; limit?: number },
  ) => [...workbenchQueryKeys.releaseLists(projectId), filters ?? {}] as const,
  release: (projectId: string, releaseId: string) =>
    [...workbenchQueryKeys.releases(projectId), "detail", releaseId] as const,
  shares: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "shares"] as const,
  shareLists: (projectId: string) =>
    [...workbenchQueryKeys.shares(projectId), "list"] as const,
  shareList: (
    projectId: string,
    filters?: { cursor?: string; limit?: number },
  ) => [...workbenchQueryKeys.shareLists(projectId), filters ?? {}] as const,
  share: (projectId: string, shareId: string) =>
    [...workbenchQueryKeys.shares(projectId), "detail", shareId] as const,
  publicShares: () => [...workbenchQueryKeys.all, "public-shares"] as const,
  publicShare: (tokenScope: string) =>
    [...workbenchQueryKeys.publicShares(), tokenScope] as const,
  publicSharedArtifactVersion: (
    tokenScope: string,
    artifactId: string,
    artifactVersionId: string,
  ) => [...workbenchQueryKeys.publicShare(tokenScope), "artifacts", artifactId, artifactVersionId] as const,
  publicSharedArtifactContent: (
    tokenScope: string,
    artifactId: string,
    artifactVersionId: string,
  ) => [...workbenchQueryKeys.publicSharedArtifactVersion(
    tokenScope,
    artifactId,
    artifactVersionId,
  ), "content"] as const,
  publicSharedArtifactAsset: (
    tokenScope: string,
    artifactId: string,
    artifactVersionId: string,
    assetId: string,
  ) => [...workbenchQueryKeys.publicSharedArtifactVersion(
    tokenScope,
    artifactId,
    artifactVersionId,
  ), "assets", assetId] as const,
  exportJobs: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "exports"] as const,
  exportJobLists: (projectId: string) =>
    [...workbenchQueryKeys.exportJobs(projectId), "list"] as const,
  exportJobList: (
    projectId: string,
    filters?: { cursor?: string; limit?: number },
  ) => [...workbenchQueryKeys.exportJobLists(projectId), filters ?? {}] as const,
  exportJob: (projectId: string, exportId: string) =>
    [...workbenchQueryKeys.exportJobs(projectId), "detail", exportId] as const,
  exportContent: (projectId: string, exportId: string) =>
    [...workbenchQueryKeys.exportJob(projectId, exportId), "content"] as const,
  projectPreviews: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "previews"] as const,
  projectPreview: (previewId: string) =>
    [...workbenchQueryKeys.all, "previews", previewId] as const,
  artifacts: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "artifacts"] as const,
  artifactLists: (projectId: string) =>
    [...workbenchQueryKeys.artifacts(projectId), "list"] as const,
  artifactList: (
    projectId: string,
    filters?: { kind?: string; cursor?: string; limit?: number },
  ) => [...workbenchQueryKeys.artifactLists(projectId), filters ?? {}] as const,
  artifactVersionFavoriteLists: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "artifact-version-favorites"] as const,
  artifactVersionFavoriteInfiniteList: (
    projectId: string,
    filters?: { limit?: number },
  ) => [
    ...workbenchQueryKeys.artifactVersionFavoriteLists(projectId),
    "infinite",
    filters ?? {},
  ] as const,
  artifact: (projectId: string, artifactId: string) =>
    [...workbenchQueryKeys.artifacts(projectId), "detail", artifactId] as const,
  artifactVersionLists: (projectId: string, artifactId: string) =>
    [...workbenchQueryKeys.artifact(projectId, artifactId), "versions"] as const,
  artifactVersionList: (
    projectId: string,
    artifactId: string,
    filters?: { cursor?: string; limit?: number },
  ) => [...workbenchQueryKeys.artifactVersionLists(projectId, artifactId), "list", filters ?? {}] as const,
  artifactVersionInfiniteList: (
    projectId: string,
    artifactId: string,
    filters?: { limit?: number },
  ) => [...workbenchQueryKeys.artifactVersionLists(projectId, artifactId), "infinite", filters ?? {}] as const,
  artifactVersion: (projectId: string, artifactId: string, artifactVersionId: string) =>
    [...workbenchQueryKeys.artifactVersionLists(projectId, artifactId), artifactVersionId] as const,
  artifactVersionPreference: (
    principalCacheNamespace: string,
    projectId: string,
    artifactId: string,
    artifactVersionId: string,
    screenId: string | null = null,
  ) => [...workbenchQueryKeys.artifactVersion(
    projectId,
    artifactId,
    artifactVersionId,
  ), "preference", { principalCacheNamespace, screenId }] as const,
  artifactVersionContent: (projectId: string, artifactId: string, artifactVersionId: string) =>
    [...workbenchQueryKeys.artifactVersion(projectId, artifactId, artifactVersionId), "content"] as const,
  artifactVersionAssets: (projectId: string, artifactId: string, artifactVersionId: string) =>
    [...workbenchQueryKeys.artifactVersion(projectId, artifactId, artifactVersionId), "assets"] as const,
  artifactVersionAsset: (
    projectId: string,
    artifactId: string,
    artifactVersionId: string,
    assetId: string,
  ) => [...workbenchQueryKeys.artifactVersionAssets(
    projectId,
    artifactId,
    artifactVersionId,
  ), assetId] as const,
  files: (projectId: string) => [...workbenchQueryKeys.project(projectId), "files"] as const,
  fileLists: (projectId: string) => [...workbenchQueryKeys.files(projectId), "list"] as const,
  fileList: (
    projectId: string,
    filters?: { status?: string; cursor?: string; limit?: number },
  ) => [...workbenchQueryKeys.fileLists(projectId), filters ?? {}] as const,
  file: (projectId: string, fileId: string) =>
    [...workbenchQueryKeys.files(projectId), "detail", fileId] as const,
  fileUploads: (projectId: string) =>
    [...workbenchQueryKeys.files(projectId), "uploads"] as const,
  fileUpload: (projectId: string, uploadSessionId: string) =>
    [...workbenchQueryKeys.fileUploads(projectId), uploadSessionId] as const,
  importSources: (projectId: string) =>
    [...workbenchQueryKeys.project(projectId), "import-sources"] as const,
  importSourceList: (
    projectId: string,
    filters?: { cursor?: string; limit?: number },
  ) => [...workbenchQueryKeys.importSources(projectId), "list", filters ?? {}] as const,
  importSource: (projectId: string, sourceId: string) =>
    [...workbenchQueryKeys.importSources(projectId), "detail", sourceId] as const,
  threadLists: (projectId: string) => [...workbenchQueryKeys.project(projectId), "threads"] as const,
  threadList: (projectId: string, filters?: { cursor?: string; limit?: number }) =>
    [...workbenchQueryKeys.threadLists(projectId), "list", filters ?? {}] as const,
  thread: (projectId: string, threadId: string) =>
    [...workbenchQueryKeys.threadLists(projectId), "detail", threadId] as const,
  entryLists: (projectId: string, threadId: string) =>
    [...workbenchQueryKeys.thread(projectId, threadId), "entries"] as const,
  entries: (
    projectId: string,
    threadId: string,
    filters?: { afterSequence?: number; limit?: number },
  ) => [...workbenchQueryKeys.entryLists(projectId, threadId), filters ?? {}] as const,
  submissionIntents: (threadId: string) =>
    [...workbenchQueryKeys.all, "threads", threadId, "submission-intents"] as const,
  submissionIntent: (intentId: string) =>
    [...workbenchQueryKeys.all, "submission-intents", intentId] as const,
  currentSubmissionIntent: (threadId: string) =>
    [...workbenchQueryKeys.submissionIntents(threadId), "current"] as const,
  runs: () => [...workbenchQueryKeys.all, "runs"] as const,
  runLists: (projectId: string, threadId: string) =>
    [...workbenchQueryKeys.thread(projectId, threadId), "runs"] as const,
  runList: (
    projectId: string,
    threadId: string,
    filters?: { cursor?: string; limit?: number },
  ) => [...workbenchQueryKeys.runLists(projectId, threadId), filters ?? {}] as const,
  run: (runId: string) => [...workbenchQueryKeys.runs(), runId] as const,
  approvals: (runId: string) => [...workbenchQueryKeys.run(runId), "approvals"] as const,
  approval: (runId: string, approvalId: string) =>
    [...workbenchQueryKeys.approvals(runId), approvalId] as const,
} as const;
