"use client";

import { useCallback } from "react";
import { toast } from "sonner";

import type { WorkbenchRunSubmission } from "@/lib/workbench/features/workbench-controller";
import type { ImportSourceDraft } from "@/lib/workbench/features/import-sources";

import { HomeScreen } from "./workbench-home-screen";
import { useWorkbenchRuntime } from "./workbench-runtime-context";

export function WorkbenchHomeRoute() {
  const {
    commitCreatedProject,
    homeProjectTab,
    homePrompt,
    logout,
    openProject,
    projectSearch,
    setHomeProjectTab,
    setHomePrompt,
    setProjectSearch,
    user,
    workbench,
  } = useWorkbenchRuntime();

  const submitHomePrompt = useCallback(async (submission: WorkbenchRunSubmission) => {
    const text = submission.prompt.trim();
    if (!text || workbench.submitting) return null;
    setHomePrompt(text);
    return workbench.startNewProject(submission, async (projectId) => {
      await commitCreatedProject(projectId, text).catch((error: unknown) => {
        toast.error(errorMessage(error, "项目界面加载失败，请重试"));
        throw error;
      });
    });
  }, [commitCreatedProject, setHomePrompt, workbench]);

  const createExternalSource = useCallback(async (request: ImportSourceDraft) => {
    if (workbench.submitting) return null;
    const result = await workbench.createProjectForImport(request);
    await commitCreatedProject(result.projectId, "").catch((error: unknown) => {
      toast.error(errorMessage(error, "来源项目加载失败，请重试"));
      throw error;
    });
    return result.source;
  }, [commitCreatedProject, workbench]);

  const homeProjectStatus = workbench.identityQuery.isError || workbench.projectsQuery.isError
    ? "error"
    : workbench.identityQuery.isPending || workbench.projectsQuery.isPending
      ? "loading"
      : "ready";
  const homeProjectError = workbench.identityQuery.error ?? workbench.projectsQuery.error;
  const designSystemCatalogStatus = workbench.identityQuery.isError
    || workbench.designSystemCatalogQuery.isError
    ? "error"
    : workbench.identityQuery.isPending || workbench.designSystemCatalogQuery.isPending
      ? "loading"
      : "ready";

  return (
    <HomeScreen
      accountUser={user}
      busy={workbench.submitting}
      designSystemCatalogItems={workbench.designSystemCatalogItems}
      designSystemCatalogStatus={designSystemCatalogStatus}
      designSystemCatalogFetchingNextPage={workbench.designSystemCatalogQuery.isFetchingNextPage}
      designSystemCatalogHasNextPage={Boolean(workbench.designSystemCatalogQuery.hasNextPage)}
      hasNextProjectPage={Boolean(workbench.projectsQuery.hasNextPage)}
      homeProjectTab={homeProjectTab}
      loadError={homeProjectError}
      loadStatus={homeProjectStatus}
      modelCatalog={workbench.runtimeModelCatalog}
      modelChoices={workbench.modelChoices}
      onLogout={async () => {
        try {
          await logout();
        } catch (error) {
          toast.error(errorMessage(error, "退出登录失败，请重试"));
          throw error;
        }
      }}
      onArchiveProject={(projectId) => workbench.archiveProject(projectId)}
      onDuplicateProject={async (projectId) => {
        const project = await workbench.duplicateProject(projectId);
        await openProject(project.id);
      }}
      onOpenProject={(projectId) => {
        void openProject(projectId);
      }}
      onLoadMoreProjects={() => {
        if (workbench.projectsQuery.isFetchingNextPage) return;
        void workbench.projectsQuery.fetchNextPage();
      }}
      onLoadMoreDesignSystems={() => {
        if (workbench.designSystemCatalogQuery.isFetchingNextPage) return;
        void workbench.designSystemCatalogQuery.fetchNextPage();
      }}
      onRetryDesignSystems={() => {
        void workbench.designSystemCatalogQuery.refetch();
      }}
      onRetryModels={() => {
        void workbench.runtimeModelsQuery.refetch();
      }}
      projectSearch={projectSearch}
      projectPageLoading={workbench.projectsQuery.isFetchingNextPage}
      onRetryProjects={() => {
        if (workbench.identityQuery.isError) {
          void workbench.identityQuery.refetch();
        } else {
          void workbench.projectsQuery.refetch();
        }
      }}
      onSubmitPrompt={submitHomePrompt}
      onCreateExternalSource={createExternalSource}
      projects={homeProjectStatus === "ready" ? workbench.homeProjects : []}
      prompt={homePrompt}
      setHomeProjectTab={setHomeProjectTab}
      setProjectSearch={setProjectSearch}
      setPrompt={setHomePrompt}
    />
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
