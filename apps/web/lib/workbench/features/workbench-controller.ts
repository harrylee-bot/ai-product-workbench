"use client";

import type {
  CreateDesignSystemRequest,
  CanvasSnapshot,
  DesignPresetCatalogItem,
  DesignSystemCatalogItem,
  ProjectBootstrap,
  ProjectRelationship,
  Run,
  RunDesignStyle,
  SubmissionIntentRunRequest,
  StartRunRequest,
  RunTargetSurface,
  ImportSource,
} from "@workbench/workbench-contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { workbenchQueryKeys } from "../query/keys";
import { useWorkbenchProjectSession } from "../project-session";
import type { Versioned } from "../transport/contracts";
import { isValidEditArtifactTargets } from "../run";
import {
  createBoardAutosaveCoordinator,
  useWorkbenchBoardController,
} from "./board";
import {
  useWorkbenchFileTransferService,
  useWorkbenchUploadRegistry,
} from "./files";
import {
  useInfiniteWorkbenchDesignSystemCatalog,
  useWorkbenchDesignSystemOperations,
  type WorkbenchDesignSystemOperations,
} from "./design-systems";
import { useWorkbenchDesignPresets } from "./design-presets";
import { flushWorkbenchBoard } from "./workbench-publication-controller";
import {
  useArchiveWorkbenchProject,
  useDuplicateWorkbenchProject,
  useInfiniteWorkbenchProjects,
  useUpdateWorkbenchProject,
  useWorkbenchProjectBootstrap,
  useWorkbenchProjectOperations,
  workbenchProjectCapabilities,
  toWorkbenchHomeProjectItems,
  type WorkbenchProjectOperations,
} from "./projects";
import { useWorkbenchIdentity } from "./identity";
import { useWorkbenchRunController } from "./run-controller";
import {
  useCurrentWorkbenchSubmissionIntent,
  useWorkbenchSubmissionCoordinator,
} from "./submission-intents";
import {
  importSourceDraftProjectTitle,
  useWorkbenchImportSourcesOperations,
  type ImportSourceDraft,
} from "./import-sources";
import { createIdempotencyKey } from "../transport/contracts";
import {
  toWorkbenchModelCatalogState,
  useWorkbenchRuntimeModels,
} from "./runtime-models";
import {
  safeParseWorkbenchThreadEntry,
  toWorkbenchModelChoices,
  toWorkbenchProjectMode,
  toWorkbenchRunActivityItems,
  toWorkbenchRunMessageItems,
  toWorkbenchRunPresentation,
  type WorkbenchModelChoice,
  type WorkbenchRunPresentation,
} from "./workbench-presenter";

export type WorkbenchRunSubmission = {
  sourceIds?: string[];
  designSystemProvision?:
    | { idempotencyKey: string; kind: "create"; request: CreateDesignSystemRequest }
    | { idempotencyKey: string; kind: "import"; sourceArtifactVersionId: string };
  designStyle?: RunDesignStyle;
  modelChoiceKey: string;
  files?: File[];
  prompt: string;
  generationIntent?: StartRunRequest["generationIntent"];
  requestedArtifactKinds?: StartRunRequest["requestedArtifactKinds"];
  artifactTargets?: StartRunRequest["artifactTargets"];
  targetSurface: RunTargetSurface;
  canvasSnapshot?: CanvasSnapshot;
  captureCanvasSnapshot?: () => CanvasSnapshot | null;
};

export type WorkbenchProjectDesignSystemChoice = {
  artifactId: string;
  artifactVersionId: string;
  label: string;
  version: number;
};

type WorkbenchProjectOperationState = {
  error: unknown;
  pending: boolean;
  token: symbol;
};

export function useWorkbenchController({
  projectQuery = "",
  projectRelationship = "owned",
}: {
  projectQuery?: string;
  projectRelationship?: ProjectRelationship;
} = {}) {
  const projectOperations = useWorkbenchProjectOperations();
  const queryClient = useQueryClient();
  const fileTransferService = useWorkbenchFileTransferService();
  const uploadRegistry = useWorkbenchUploadRegistry(fileTransferService);
  const importSourcesOperations = useWorkbenchImportSourcesOperations();
  const identityQuery = useWorkbenchIdentity();
  const workspaceId = identityQuery.data?.defaultWorkspaceId ?? "";
  const projectsQuery = useInfiniteWorkbenchProjects({
    limit: 50,
    q: projectQuery || undefined,
    relationship: projectRelationship,
  });
  const runtimeModelsQuery = useWorkbenchRuntimeModels();
  const designPresetsQuery = useWorkbenchDesignPresets();
  const designSystemOperations = useWorkbenchDesignSystemOperations();
  const designSystemCatalogQuery = useInfiniteWorkbenchDesignSystemCatalog(workspaceId, {
    limit: 20,
  });
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const projectSession = useWorkbenchProjectSession(selectedProjectId);
  const selectedProjectIdRef = useRef("");
  const preparedProjectCloseRef = useRef<string | null>(null);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const newProjectOperationOwnersRef = useRef(new Map<string, symbol>());
  const [newProjectOperationStates, setNewProjectOperationStates] = useState(
    () => new Map<string, WorkbenchProjectOperationState>(),
  );
  const projectSubmissionOwnersRef = useRef(new Map<string, symbol>());
  const [projectSubmissionStates, setProjectSubmissionStates] = useState(
    () => new Map<string, WorkbenchProjectOperationState>(),
  );
  const acceptSubmittedRun = useCallback((run: Run) => {
    clearSettledProjectOperation(setNewProjectOperationStates, run.projectId);
    clearSettledProjectOperation(setProjectSubmissionStates, run.projectId);
    if (!projectSession.isCurrent() || run.projectId !== projectSession.projectId) return;
    setActiveRun(run);
  }, [projectSession]);
  const bootstrapQuery = useWorkbenchProjectBootstrap(selectedProjectId);
  const bootstrap = bootstrapQuery.data?.value;
  const selectedThreadId = bootstrap?.selectedThreadId ?? "";
  const currentSubmissionIntentQuery = useCurrentWorkbenchSubmissionIntent(selectedThreadId);
  const submissionCoordinator = useWorkbenchSubmissionCoordinator({
    currentIntent: currentSubmissionIntentQuery.data?.item ?? null,
    onRun: acceptSubmittedRun,
    projectId: selectedProjectId,
    uploads: uploadRegistry,
  });
  const coordinatorOwnsSelectedProject = currentSubmissionIntentQuery.data?.item?.projectId
    === selectedProjectId;
  const currentIntentPending = Boolean(
    selectedProjectId
    && (bootstrapQuery.isPending || (selectedThreadId && currentSubmissionIntentQuery.isPending)),
  );
  const newProjectOperationState = newProjectOperationStates.get(selectedProjectId) ?? null;
  const projectSubmissionState = projectSubmissionStates.get(selectedProjectId) ?? null;
  const submissionBusy = Boolean(projectSubmissionState?.pending)
    || Boolean(newProjectOperationState?.pending)
    || coordinatorOwnsSelectedProject
    || currentIntentPending;
  const updateProject = useUpdateWorkbenchProject(selectedProjectId);
  const duplicateProjectMutation = useDuplicateWorkbenchProject(selectedProjectId);
  const archiveProjectMutation = useArchiveWorkbenchProject(selectedProjectId);
  const boardController = useWorkbenchBoardController(selectedProjectId);
  const capabilities = useMemo(
    () => workbenchProjectCapabilities(bootstrap?.access.role),
    [bootstrap?.access.role],
  );
  const currentRun = activeRun?.projectId === selectedProjectId
    ? activeRun
    : bootstrap?.latestRun ?? null;
  const runController = useWorkbenchRunController({ run: currentRun });
  const previousPresentation = useRef<WorkbenchRunPresentation | null>(null);
  const runPresentation = useMemo(
    () => toWorkbenchRunPresentation(runController.projection, previousPresentation.current),
    [runController.projection],
  );
  const runActivities = useMemo(
    () => runController.projection
      ? toWorkbenchRunActivityItems(runController.projection)
      : [],
    [runController.projection],
  );
  const runMessages = useMemo(
    () => runController.projection
      ? toWorkbenchRunMessageItems(runController.projection)
      : [],
    [runController.projection],
  );
  const runDraftArtifacts = useMemo(
    () => runController.projection
      ? runController.projection.draftArtifactOrder.map((artifactIndex) => {
          const draft = runController.projection?.draftArtifacts[String(artifactIndex)];
          if (!draft) throw new Error(`Run draft order references missing Artifact ${artifactIndex}`);
          return draft;
        })
      : [],
    [runController.projection],
  );
  const liveRunPhaseLabel = runController.projection
    ? runController.projection.phaseLabel
    : currentRun?.phaseLabel ?? null;
  const liveRunStatus = runController.projection
    ? runController.projection.status
    : currentRun?.status ?? null;

  useEffect(() => {
    previousPresentation.current = runPresentation;
  }, [runPresentation]);

  useEffect(() => {
    if (activeRun && bootstrap?.latestRun?.id === activeRun.id) {
      setActiveRun(bootstrap.latestRun);
    }
  }, [activeRun, bootstrap?.latestRun]);

  useEffect(() => {
    if (!capabilities.canEdit) return;
    const store = boardController.store;
    if (!store) return;
    const autosave = createBoardAutosaveCoordinator({
      store,
      save: boardController.persistSnapshot,
      onSaved: boardController.publishSavedSnapshot,
    });
    return () => {
      void autosave.dispose();
    };
  }, [boardController.persistSnapshot, boardController.store, capabilities.canEdit]);

  const modelChoices = useMemo(
    () => toWorkbenchModelChoices(runtimeModelsQuery.data?.items ?? []),
    [runtimeModelsQuery.data?.items],
  );
  const runtimeModelCatalog = useMemo(
    () => toWorkbenchModelCatalogState({
      error: runtimeModelsQuery.error,
      isError: runtimeModelsQuery.isError,
      isFetching: runtimeModelsQuery.isFetching,
      isPending: runtimeModelsQuery.isPending,
    }, modelChoices.length),
    [
      modelChoices.length,
      runtimeModelsQuery.error,
      runtimeModelsQuery.isError,
      runtimeModelsQuery.isFetching,
      runtimeModelsQuery.isPending,
    ],
  );
  const projectListItems = useMemo(
    () => projectsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [projectsQuery.data?.pages],
  );
  const homeProjects = useMemo(
    () => toWorkbenchHomeProjectItems(projectListItems),
    [projectListItems],
  );
  const designSystemCatalogItems = useMemo(
    () => dedupeDesignSystemCatalogItems(
      designSystemCatalogQuery.data?.pages.flatMap((page) => page.items) ?? [],
    ),
    [designSystemCatalogQuery.data?.pages],
  );
  const designPresetItems = useMemo<DesignPresetCatalogItem[]>(
    () => designPresetsQuery.data?.items ?? [],
    [designPresetsQuery.data?.items],
  );
  const projectDesignSystemChoices = useMemo<WorkbenchProjectDesignSystemChoice[]>(
    () => (bootstrap?.artifacts ?? []).flatMap((artifact) => {
      const version = artifact.currentVersion;
      if (artifact.kind !== "design_system" || !version || version.status !== "ready") return [];
      return [{
        artifactId: artifact.id,
        artifactVersionId: version.artifactVersionId,
        label: artifact.title,
        version: version.version,
      }];
    }),
    [bootstrap?.artifacts],
  );

  const flushSelectedBoard = useCallback(async () => {
    if (!selectedProjectId || !boardController.store) return;
    await flushWorkbenchBoard(boardController);
  }, [boardController, selectedProjectId]);

  const prepareProjectOpen = useCallback(async (projectId: string, signal?: AbortSignal) => {
    if (!projectId || projectId === selectedProjectIdRef.current || signal?.aborted) return;
    await flushSelectedBoard();
    if (signal?.aborted) return;
    await loadBootstrap(projectOperations, queryClient, projectId);
  }, [flushSelectedBoard, projectOperations, queryClient]);

  const commitProjectOpen = useCallback((projectId: string) => {
    if (!projectId) return;
    preparedProjectCloseRef.current = null;
    const currentProjectId = selectedProjectIdRef.current;
    if (projectId === currentProjectId) return;
    if (currentProjectId) uploadRegistry.releaseProjectUploads(currentProjectId);
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setActiveRun(null);
    previousPresentation.current = null;
  }, [uploadRegistry.releaseProjectUploads]);

  const prepareProjectClose = useCallback(async (signal?: AbortSignal) => {
    const projectId = selectedProjectIdRef.current;
    if (!projectId || signal?.aborted) return;
    await flushSelectedBoard();
    if (signal?.aborted || selectedProjectIdRef.current !== projectId) return;
    preparedProjectCloseRef.current = projectId;
  }, [flushSelectedBoard]);

  const finalizeProjectClose = useCallback((projectId: string) => {
    if (
      !projectId
      || preparedProjectCloseRef.current !== projectId
      || selectedProjectIdRef.current !== projectId
    ) {
      return;
    }
    preparedProjectCloseRef.current = null;
    uploadRegistry.releaseProjectUploads(projectId);
    selectedProjectIdRef.current = "";
    setSelectedProjectId("");
    setActiveRun(null);
    previousPresentation.current = null;
  }, [uploadRegistry.releaseProjectUploads]);

  const abortProjectOpen = useCallback((projectId: string) => {
    if (!projectId) return;
    uploadRegistry.releaseProjectUploads(projectId);
    if (selectedProjectIdRef.current !== projectId) return;
    preparedProjectCloseRef.current = null;
    selectedProjectIdRef.current = "";
    setSelectedProjectId("");
    setActiveRun(null);
    previousPresentation.current = null;
  }, [uploadRegistry.releaseProjectUploads]);

  const startNewProject = useCallback(async (
    submission: WorkbenchRunSubmission,
    onProjectCreated?: (projectId: string) => Promise<void> | void,
  ) => {
    const homeOwner = "";
    if (!workspaceId || newProjectOperationOwnersRef.current.has(homeOwner)) return null;
    const operationToken = Symbol("new-project");
    addProjectOperationOwner(
      newProjectOperationOwnersRef,
      setNewProjectOperationStates,
      homeOwner,
      operationToken,
    );
    let createdProjectId = "";
    try {
      const model = resolveHomeSubmissionModel(submission, modelChoices);
      const created = await projectOperations.createProject(workspaceId, {
        title: projectTitleFromPrompt(submission.prompt),
      });
      createdProjectId = created.value.id;
      if (!addProjectOperationOwner(
        newProjectOperationOwnersRef,
        setNewProjectOperationStates,
        createdProjectId,
        operationToken,
      )) {
        throw new Error("The created Project already has a submission in progress");
      }
      try {
        await onProjectCreated?.(createdProjectId);
        if (onProjectCreated) {
          removeProjectOperationOwner(
            newProjectOperationOwnersRef,
            setNewProjectOperationStates,
            homeOwner,
            operationToken,
          );
        }
      } catch (error) {
        abortProjectOpen(createdProjectId);
        removeProjectOperationOwner(
          newProjectOperationOwnersRef,
          setNewProjectOperationStates,
          createdProjectId,
          operationToken,
        );
        createdProjectId = "";
        throw error;
      }
      let nextBootstrap = await loadBootstrap(projectOperations, queryClient, createdProjectId);
      const designStyle = await provisionDesignStyle(
        designSystemOperations,
        queryClient,
        workspaceId,
        createdProjectId,
        submission,
      );
      if (submission.designSystemProvision) {
        nextBootstrap = await loadBootstrap(projectOperations, queryClient, createdProjectId);
      }
      const threadId = requireSelectedThreadId(nextBootstrap);
      await submissionCoordinator.submitPrepared({
        projectId: createdProjectId,
        threadId,
        submission: {
          files: submission.files,
          request: submissionIntentRunRequest(submission, model, designStyle),
        },
      });
      await queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.projectLists() });
      settleProjectOperation(
        newProjectOperationOwnersRef,
        setNewProjectOperationStates,
        operationToken,
        null,
      );
      return createdProjectId;
    } catch (error) {
      settleProjectOperation(
        newProjectOperationOwnersRef,
        setNewProjectOperationStates,
        operationToken,
        { error },
      );
      return createdProjectId || null;
    }
  }, [
    modelChoices,
    abortProjectOpen,
    designSystemOperations,
    submissionCoordinator.submitPrepared,
    queryClient,
    projectOperations,
    workspaceId,
  ]);

  const createProjectForImport = useCallback(async (
    request: ImportSourceDraft,
  ): Promise<{ projectId: string; source: ImportSource }> => {
    const homeOwner = "";
    if (!workspaceId || newProjectOperationOwnersRef.current.has(homeOwner)) {
      throw new Error("The workspace is not ready for a new import project");
    }
    const operationToken = Symbol("import-project");
    if (!addProjectOperationOwner(
      newProjectOperationOwnersRef,
      setNewProjectOperationStates,
      homeOwner,
      operationToken,
    )) {
      throw new Error("Another project operation is already running");
    }
    let createdProjectId = "";
    try {
      const created = await projectOperations.createProject(workspaceId, {
        title: importSourceDraftProjectTitle(request),
      });
      createdProjectId = created.value.id;
      if (!addProjectOperationOwner(
        newProjectOperationOwnersRef,
        setNewProjectOperationStates,
        createdProjectId,
        operationToken,
      )) {
        throw new Error("The created Project already has an operation in progress");
      }
      const source = await importSourcesOperations.createImportSource(
        createdProjectId,
        request,
        createIdempotencyKey("import-source"),
      );
      await queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.projectLists() });
      settleProjectOperation(
        newProjectOperationOwnersRef,
        setNewProjectOperationStates,
        operationToken,
        null,
      );
      return { projectId: createdProjectId, source: source.value };
    } catch (error) {
      settleProjectOperation(
        newProjectOperationOwnersRef,
        setNewProjectOperationStates,
        operationToken,
        { error },
      );
      throw error;
    }
  }, [
    importSourcesOperations,
    projectOperations,
    queryClient,
    workspaceId,
  ]);

  const startProjectRun = useCallback(async (submission: WorkbenchRunSubmission) => {
    const targetProjectId = selectedProjectId;
    if (
      !targetProjectId
      || submissionBusy
      || !selectedThreadId
      || !currentSubmissionIntentQuery.isSuccess
      || projectSubmissionOwnersRef.current.has(targetProjectId)
      || newProjectOperationOwnersRef.current.has(targetProjectId)
    ) return null;
    clearSettledProjectOperation(setNewProjectOperationStates, targetProjectId);
    clearSettledProjectOperation(setProjectSubmissionStates, targetProjectId);
    const operationToken = Symbol(`project-submission:${targetProjectId}`);
    if (!addProjectOperationOwner(
      projectSubmissionOwnersRef,
      setProjectSubmissionStates,
      targetProjectId,
      operationToken,
    )) return null;
    let failure: { error: unknown } | null = null;
    try {
      if (!capabilities.canRun) {
        throw new Error("This Project role cannot start Runs");
      }
      if ((submission.files?.length ?? 0) > 0 && !capabilities.canUpload) {
        throw new Error("This Project role cannot upload files");
      }
      const model = resolveRunnableSubmissionModel(submission, modelChoices);
      await flushSelectedBoard();
      let currentBootstrap = bootstrapQuery.data
        ?? await loadBootstrap(projectOperations, queryClient, targetProjectId);
      const designStyle = await provisionDesignStyle(
        designSystemOperations,
        queryClient,
        workspaceId,
        targetProjectId,
        submission,
      );
      if (submission.designSystemProvision) {
        currentBootstrap = await loadBootstrap(projectOperations, queryClient, targetProjectId);
      }
      const threadId = requireSelectedThreadId(currentBootstrap);
      const run = await submissionCoordinator.submitPrepared({
        projectId: targetProjectId,
        threadId,
        submission: {
          files: submission.files,
          request: submissionIntentRunRequest(submission, model, designStyle),
        },
      });
      return run?.id ?? null;
    } catch (error) {
      failure = { error };
      return null;
    } finally {
      settleProjectOperation(
        projectSubmissionOwnersRef,
        setProjectSubmissionStates,
        operationToken,
        failure,
      );
    }
  }, [
    bootstrapQuery.data,
    capabilities.canRun,
    capabilities.canUpload,
    designSystemOperations,
    flushSelectedBoard,
    modelChoices,
    queryClient,
    selectedProjectId,
    selectedThreadId,
    projectOperations,
    submissionBusy,
    submissionCoordinator.submitPrepared,
    currentSubmissionIntentQuery.isSuccess,
    workspaceId,
  ]);

  const renameProject = useCallback(async (title: string) => {
    const normalized = title.trim();
    if (!selectedProjectId || !normalized) throw new Error("Project title is required");
    if (!capabilities.canEdit) throw new Error("This Project role cannot edit the Project");
    const result = await updateProject.mutateAsync({ request: { title: normalized } });
    return result.value;
  }, [capabilities.canEdit, selectedProjectId, updateProject]);

  const duplicateProject = useCallback(async (projectId = selectedProjectId) => {
    const listedProject = projectListItems.find((project) => project.id === projectId);
    const targetCapabilities = projectId === selectedProjectId
      ? capabilities
      : workbenchProjectCapabilities(listedProject?.role);
    if (!projectId || !targetCapabilities.canDuplicate) {
      throw new Error("This Project role cannot duplicate the Project");
    }
    if (projectId === selectedProjectId) await flushSelectedBoard();
    const result = await duplicateProjectMutation.mutateAsync({ projectId });
    return result.value.project;
  }, [capabilities, duplicateProjectMutation, flushSelectedBoard, projectListItems, selectedProjectId]);

  const archiveProject = useCallback(async (projectId = selectedProjectId) => {
    const listedProject = projectListItems.find((project) => project.id === projectId);
    const targetCapabilities = projectId === selectedProjectId
      ? capabilities
      : workbenchProjectCapabilities(listedProject?.role);
    if (!projectId || !targetCapabilities.canArchive) {
      throw new Error("This Project role cannot archive the Project");
    }
    if (projectId === selectedProjectId) await flushSelectedBoard();
    const result = await archiveProjectMutation.mutateAsync({
      projectId,
      ifMatch: projectId === selectedProjectId || !listedProject
        ? undefined
        : `"${listedProject.revision}"`,
    });
    return result.value;
  }, [archiveProjectMutation, capabilities, flushSelectedBoard, projectListItems, selectedProjectId]);

  const retryBoardSave = useCallback(async () => {
    if (!boardController.store) throw new Error("The Project Board is not ready");
    const state = boardController.store.getState();
    if (state.saveStatus === "conflict") {
      throw state.lastSaveError ?? new Error("Board revision conflict");
    }
    if (state.dirty) await boardController.save();
    return flushWorkbenchBoard(boardController);
  }, [boardController]);

  const adoptRun = useCallback((run: Run) => {
    if (!projectSession.isCurrent()) {
      clearSettledProjectOperation(setNewProjectOperationStates, run.projectId);
      clearSettledProjectOperation(setProjectSubmissionStates, run.projectId);
      return;
    }
    if (run.projectId !== projectSession.projectId) {
      throw new Error("Cannot activate a Run from another Project");
    }
    clearSettledProjectOperation(setNewProjectOperationStates, run.projectId);
    clearSettledProjectOperation(setProjectSubmissionStates, run.projectId);
    setActiveRun(run);
  }, [projectSession]);

  return {
    activeProject: bootstrap?.project ?? null,
    adoptRun,
    bootstrap,
    bootstrapQuery,
    boardController,
    capabilities,
    archiveProject,
    archiveProjectMutation,
    commitProjectOpen,
    currentRun,
    duplicateProject,
    duplicateProjectMutation,
    designSystemCatalogItems,
    designSystemCatalogQuery,
    designPresetItems,
    designPresetsQuery,
    generationProgress: runPresentation.generationProgress,
    generationStage: runController.projection?.generationStage ?? null,
    homeProjects,
    identityQuery,
    latestPrompt: latestUserPrompt(bootstrap),
    modelChoices,
    finalizeProjectClose,
    phase: runPresentation.phase,
    projectMode: toWorkbenchProjectMode(bootstrap?.artifacts ?? [], currentRun),
    projectDesignSystemChoices,
    prepareProjectClose,
    prepareProjectOpen,
    projectsQuery,
    renameProject,
    retryBoardSave,
    runController,
    runDraftArtifacts,
    runActivities,
    runMessages,
    runPhaseLabel: liveRunPhaseLabel,
    runPresentation,
    runStatus: liveRunStatus,
    runtimeModelCatalog,
    runtimeModelsQuery,
    selectedProjectId,
    startNewProject,
    createProjectForImport,
    startProjectRun,
    submissionIntentQuery: currentSubmissionIntentQuery,
    submissionRecovery: submissionCoordinator.recovery,
    submissionError: newProjectOperationState?.error
      ?? projectSubmissionState?.error
      ?? currentSubmissionIntentQuery.error
      ?? (coordinatorOwnsSelectedProject ? submissionCoordinator.actionError : null),
    submitting: submissionBusy,
    cancelSubmissionRecovery: submissionCoordinator.cancelRecovery,
    retrySubmissionRecovery: submissionCoordinator.retryRecovery,
    selectSubmissionRecoveryFiles: submissionCoordinator.selectRecoveryFiles,
    uploads: uploadRegistry.uploads,
    pauseUpload: uploadRegistry.pauseUpload,
    resumeUpload: uploadRegistry.resumeUpload,
    retryUpload: uploadRegistry.retryUpload,
    cancelUpload: uploadRegistry.cancelUpload,
    updateProject,
  };
}

function addProjectOperationOwner(
  ownersRef: MutableRefObject<Map<string, symbol>>,
  setStates: Dispatch<SetStateAction<Map<string, WorkbenchProjectOperationState>>>,
  projectId: string,
  token: symbol,
): boolean {
  const existingToken = ownersRef.current.get(projectId);
  if (existingToken && existingToken !== token) return false;
  ownersRef.current.set(projectId, token);
  setStates((current) => {
    const existingState = [...current.values()].find((state) => state.token === token);
    const next = new Map(current);
    next.set(projectId, existingState ?? { error: null, pending: true, token });
    return next;
  });
  return true;
}

function removeProjectOperationOwner(
  ownersRef: MutableRefObject<Map<string, symbol>>,
  setStates: Dispatch<SetStateAction<Map<string, WorkbenchProjectOperationState>>>,
  projectId: string,
  token: symbol,
) {
  if (ownersRef.current.get(projectId) !== token) return;
  ownersRef.current.delete(projectId);
  setStates((current) => {
    if (current.get(projectId)?.token !== token) return current;
    const next = new Map(current);
    next.delete(projectId);
    return next;
  });
}

function settleProjectOperation(
  ownersRef: MutableRefObject<Map<string, symbol>>,
  setStates: Dispatch<SetStateAction<Map<string, WorkbenchProjectOperationState>>>,
  token: symbol,
  failure: { error: unknown } | null,
) {
  for (const [projectId, ownerToken] of ownersRef.current) {
    if (ownerToken === token) ownersRef.current.delete(projectId);
  }
  setStates((current) => {
    let changed = false;
    const next = new Map(current);
    for (const [projectId, state] of current) {
      if (state.token !== token) continue;
      changed = true;
      if (failure) next.set(projectId, { ...state, error: failure.error, pending: false });
      else next.delete(projectId);
    }
    return changed ? next : current;
  });
}

function clearSettledProjectOperation(
  setStates: Dispatch<SetStateAction<Map<string, WorkbenchProjectOperationState>>>,
  projectId: string,
) {
  setStates((current) => {
    const state = current.get(projectId);
    if (!state || state.pending) return current;
    const next = new Map(current);
    next.delete(projectId);
    return next;
  });
}

async function provisionDesignStyle(
  designSystems: WorkbenchDesignSystemOperations,
  queryClient: ReturnType<typeof useQueryClient>,
  workspaceId: string,
  projectId: string,
  submission: WorkbenchRunSubmission,
): Promise<RunDesignStyle> {
  const provision = submission.designSystemProvision;
  if (!provision) return submission.designStyle ?? { kind: "automatic" };

  const artifactVersionId = provision.kind === "create"
    ? (await designSystems.createDesignSystem(
        projectId,
        provision.request,
        provision.idempotencyKey,
      )).artifactVersionId
    : (await designSystems.importDesignSystem(projectId, {
        sourceArtifactVersionId: provision.sourceArtifactVersionId,
      }, provision.idempotencyKey)).targetArtifactVersionId;

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.artifactLists(projectId) }),
    queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.bootstraps(projectId) }),
    queryClient.invalidateQueries({ queryKey: workbenchQueryKeys.designSystemCatalogs(workspaceId) }),
  ]);
  return { kind: "artifact", artifactVersionId };
}

function dedupeDesignSystemCatalogItems(
  items: readonly DesignSystemCatalogItem[],
): DesignSystemCatalogItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.artifactVersionId)) return false;
    seen.add(item.artifactVersionId);
    return true;
  });
}

async function loadBootstrap(
  projectOperations: WorkbenchProjectOperations,
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
): Promise<Versioned<ProjectBootstrap>> {
  const bootstrap = await projectOperations.getProjectBootstrap(projectId);
  queryClient.setQueryData(workbenchQueryKeys.bootstrap(projectId), bootstrap);
  queryClient.setQueryData(workbenchQueryKeys.board(projectId), {
    value: bootstrap.value.board,
    etag: `"${bootstrap.value.board.revision}"`,
  });
  return bootstrap;
}

function submissionIntentRunRequest(
  submission: WorkbenchRunSubmission,
  model: WorkbenchModelChoice,
  designStyle: RunDesignStyle,
): SubmissionIntentRunRequest {
  return {
    prompt: submission.prompt,
    modelId: model.modelId,
    workflow: model.workflow,
    generationIntent: submission.generationIntent ?? null,
    targetSurface: submission.targetSurface,
    designStyle,
    sourceIds: [...new Set(submission.sourceIds ?? [])],
    artifactTargets: submission.artifactTargets ?? [],
    requestedArtifactKinds: submission.requestedArtifactKinds ?? [],
    canvasSnapshot: submission.captureCanvasSnapshot?.() ?? submission.canvasSnapshot ?? null,
  };
}

function requireSelectedThreadId(bootstrap: Versioned<ProjectBootstrap>): string {
  const threadId = bootstrap.value.selectedThreadId;
  if (!threadId) throw new Error("The selected Project has no active Thread");
  return threadId;
}

export function resolveRunnableSubmissionModel(
  submission: WorkbenchRunSubmission,
  modelChoices: readonly WorkbenchModelChoice[],
): WorkbenchModelChoice {
  const model = modelChoices.find((choice) => choice.key === submission.modelChoiceKey);
  if (!model) throw new Error("Select an available runtime model before starting a Run");
  const artifactTargets = submission.artifactTargets ?? [];
  const generationIntent = submission.generationIntent ?? null;
  if (
    model.workflow === "edit"
    && !isValidEditArtifactTargets(artifactTargets)
  ) {
    throw new Error("Select at least one valid Artifact before starting an Edit Run");
  }
  if (
    model.workflow === "generate"
    && artifactTargets.length > 0
    && generationIntent === null
  ) {
    throw new Error("Targeted Generate requires an explicit generation intent");
  }
  if (
    model.workflow === "generate"
    && artifactTargets.length === 0
    && generationIntent !== null
  ) {
    throw new Error("A generation intent requires explicit source screens");
  }
  if (
    model.workflow !== "generate"
    && generationIntent !== null
  ) {
    throw new Error("Only Generate accepts a generation intent");
  }
  if (
    model.workflow === "generate"
    && artifactTargets.length > 0
    && !(submission.requestedArtifactKinds ?? []).includes("prototype")
  ) {
    throw new Error("Targeted Generate requires a Prototype Artifact request");
  }
  if (
    model.workflow === "generate"
    && artifactTargets.some((target) => target.screenIds.length === 0)
  ) {
    throw new Error("Targeted Generate requires explicit screen targets");
  }
  if (
    model.workflow !== "edit"
    && model.workflow !== "generate"
    && artifactTargets.length > 0
  ) {
    throw new Error("Artifact targets are not supported by this workflow");
  }
  return model;
}

export function resolveHomeSubmissionModel(
  submission: WorkbenchRunSubmission,
  modelChoices: readonly WorkbenchModelChoice[],
): WorkbenchModelChoice {
  if ((submission.artifactTargets?.length ?? 0) > 0) {
    const selected = modelChoices.find((choice) => choice.key === submission.modelChoiceKey);
    if (!selected) return resolveRunnableSubmissionModel(submission, modelChoices);
    if (selected.workflow !== "edit") {
      throw new Error("Artifact targets require an existing Project selection");
    }
  }
  const model = resolveRunnableSubmissionModel(submission, modelChoices);
  if (model.workflow === "edit") {
    throw new Error("Edit requires an existing Project Artifact selection");
  }
  return model;
}

function projectTitleFromPrompt(prompt: string): string {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}

function latestUserPrompt(bootstrap: ProjectBootstrap | undefined): string {
  if (!bootstrap) return "";
  for (let index = bootstrap.entries.length - 1; index >= 0; index -= 1) {
    const parsed = safeParseWorkbenchThreadEntry(bootstrap.entries[index]);
    if (parsed.success && parsed.data.role === "user") return parsed.data.content.text;
  }
  return "";
}
