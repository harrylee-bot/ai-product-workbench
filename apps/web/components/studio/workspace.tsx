"use client";

import {
  useCreateWorkbenchPrototypeV2Export,
  useCreateWorkbenchPrototypeV2Feedback,
  useCreateWorkbenchPrototypeV2PreviewToken,
  useCreateWorkbenchPrototypeV2Share,
  useCancelWorkbenchPrototypeV2Export,
  useDownloadWorkbenchPrototypeV2Export,
  useResolveWorkbenchPrototypeV2Feedback,
  useRevokeWorkbenchPrototypeV2Share,
  useReviewWorkbenchPrototypeV2Revision,
  useRetryWorkbenchPrototypeV2Export,
  useCancelWorkbenchPrototypeV2Plan,
  useWorkbenchPrototypeV2Plan,
  useWorkbenchPrototypeV2Plans,
  useWorkbenchPrototypeV2Revision,
  useWorkbenchPrototypeV2Revisions,
  useWorkbenchPrototypeV2RevisionDiff,
  useWorkbenchPrototypeV2Shares,
  useWorkbenchPrototypeV2Exports,
  useRetryWorkbenchPrototypeV2Plan,
  useWorkbenchPrototypeProgress,
} from "@/lib/workbench/features/prototype-v2";
import {
  canonicalJson,
  createPrototypeFeedbackRequestSchema,
  createPrototypeShareRequestSchema,
  type PrototypeExport,
  type PrototypeFeedback,
  type PrototypeFeedbackLocation,
  type PrototypeFeedbackLocations,
  type PrototypePlan,
  type PrototypeShare,
  type RequirementContext,
} from "@workbench/workbench-contracts";
import { z } from "zod";
import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { createIdempotencyKey } from "@/lib/workbench/transport/contracts";
import {
  studioRecordKey,
  useStudioStoredRecord,
} from "@/lib/studio/stored-record";
import { type PrototypePreviewInteraction } from "./preview";
import { useStudioRun, projectedRun, isActiveRun } from "@/lib/studio/run";
import { useWorkbenchPrototypeV2Api } from "@/lib/studio/api";
import { useStudioComposerSession } from "@/lib/studio/composer-session";
import { useRequirementDiscussion } from "@/lib/studio/use-requirement-discussion";
import { requirementView } from "@/lib/studio/requirement-view-adapter";
import { RequirementInput } from "./requirement-input";
import { RequirementSessions } from "./requirement-sessions";
import { PlanInputSummary } from "./plan-input";
import { RevisionRelations, RunOutputs } from "./relations";
import { PageStage } from "./page-stage";
import { StudioComposer, type StudioComposerProps } from "./composer";
import type { StudioArtifactContext, StudioView } from "@/lib/studio/types";
import type { ProjectBootstrap } from "@workbench/workbench-contracts";
import { verifyDownload, saveBlob } from "./actions";
import { Main } from "./onlook/main";
import { DesignPanel } from "./onlook/design-panel";
import { ProjectViews, RunDetails } from "./project-views";
import Link from "next/link";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { isWorkbenchApiError } from "@/lib/workbench/api";
import { workbenchQueryKeys } from "@/lib/workbench/query/keys";
import {
  PanelsTopLeft,
  FileText,
  FolderOpen,
  BookOpen,
  Activity,
  CloudUpload,
  Settings,
  ListTodo,
  History,
  MessageSquare,
  Send,
} from "lucide-react";

const feedbackCommandSchema = z
  .object({
    version: z.literal(1),
    signature: z.string(),
    key: z.string().min(8),
    revisionId: z.string().min(1),
    request: createPrototypeFeedbackRequestSchema,
  })
  .strict();

const shareCommandSchema = z.object({
  version: z.literal(1),
  key: z.string().min(8),
  request: createPrototypeShareRequestSchema,
}).strict();

const studioPanelSchema = z.enum(["plan", "versions", "feedback", "delivery"]);
type StudioPanel = z.infer<typeof studioPanelSchema>;

function artifactPromptLabel(context: StudioArtifactContext) {
  if (context.generationIntent === "followup-design") return "设计变体";
  if (context.generationIntent === "interactive-prototype") return "交互变体";
  return context.workflow === "generate" ? "基于固定 PRD 生成" : "完善固定产物";
}

type StudioWorkspaceProps = {
  projectId: string;
  canEdit: boolean;
  composer: Omit<
    StudioComposerProps,
    "prompt" | "setPrompt" | "draft" | "updateDraft" | "onSubmit"
  >;
  bootstrap: ProjectBootstrap;
};

type Selection = { planId: string; revisionId: string; pageId: string };
export function readPrototypeSelection(search: string): Selection {
  const params = new URLSearchParams(search);
  return {
    planId: params.get("plan") ?? "",
    revisionId: params.get("revision") ?? "",
    pageId: params.get("page") ?? "",
  };
}

export function writePrototypeSelection(selection: Selection): void {
  const url = new URL(window.location.href);
  for (const [key, value] of [
    ["plan", selection.planId],
    ["revision", selection.revisionId],
    ["page", selection.pageId],
  ]) {
    if (value) url.searchParams.set(key!, value);
    else url.searchParams.delete(key!);
  }
  window.history.replaceState(null, "", url);
}

export function StudioWorkspace({
  projectId,
  canEdit,
  composer,
  bootstrap,
}: StudioWorkspaceProps) {
  const api = useWorkbenchPrototypeV2Api();
  const [selection, setSelection] = useState<Selection>(() =>
    readPrototypeSelection(
      typeof window === "undefined" ? "" : window.location.search,
    ),
  );
  const {
    planId,
    revisionId: selectedRevisionId,
    pageId: selectedPageId,
  } = selection;
  const { user } = useWorkbenchAuth(),
    queryClient = useQueryClient();
  const composerSession = useStudioComposerSession(user?.id ?? "", projectId);
  const composerEntry = composerSession.entry;
  const inputContext =
    composerEntry.context.kind === "input" ? composerEntry.context : undefined;
  const artifactContext =
    composerEntry.context.kind === "artifact"
      ? composerEntry.context.artifact
      : undefined;
  const readView = (): StudioView => {
    const value =
      typeof window === "undefined"
        ? ""
        : new URLSearchParams(window.location.search).get("view");
    return [
      "pages",
      "documents",
      "resources",
      "knowledge",
      "runs",
      "publishing",
      "project",
    ].includes(value ?? "")
      ? (value as StudioView)
      : "pages";
  };
  const [view, setViewState] = useState<StudioView>(readView);
  const setView = (next: StudioView) => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.pushState(null, "", url);
    setViewState(next);
  };
  const [feedback, setFeedback] = useState("");
  const [feedbackScope, setFeedbackScope] = useState<"page" | "version">(
    "version",
  );
  const [feedbackSourceId, setFeedbackSourceId] = useState("");
  const [feedbackLocation, setFeedbackLocation] = useState<{
    revisionId: string;
    pageId: string;
    nodeId: string | null;
    requestId: string;
  }>();
  const panelRecord = useStudioStoredRecord(
    studioRecordKey(user?.id, projectId, "expanded-panel-v1"),
    studioPanelSchema,
  );
  const panel = panelRecord.value;
  const latestPanel = useRef(panel);
  latestPanel.current = panel;
  const setPanel = (value: SetStateAction<StudioPanel | null>) => {
    if (!panelRecord.isCurrent()) return;
    // An async confirmation must consider the panel the user opened meanwhile.
    const next = typeof value === "function" ? value(latestPanel.current) : value;
    if (next === latestPanel.current) return;
    latestPanel.current = next;
    if (next) panelRecord.save(next);
    else panelRecord.clear();
  };
  const panelTrigger = useRef<HTMLElement | null>(null);
  const openPanel = (next: StudioPanel, trigger: HTMLElement | null) => {
    panelTrigger.current = trigger;
    setPanel(next);
  };
  const [focused, setFocused] = useState(false);
  const [feedbackIds, setFeedbackIds] = useState<string[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState("all");
  const [expiry, setExpiry] = useState("7");
  const shareRecord = useStudioStoredRecord(
    studioRecordKey(user?.id, projectId, "share-command-v1"),
    shareCommandSchema,
  );
  const shareFlight = useRef(false);
  const [followRun, setFollowRun] = useState(true);
  const [clock, setClock] = useState(Date.now());
  const progress = useWorkbenchPrototypeProgress(projectId, planId);
  const livePlanRun = projectedRun(progress.snapshot?.run, progress.projection);
  const [directRunId, setDirectRunId] = useState(() => {
    const saved =
      typeof window === "undefined"
        ? ""
        : new URLSearchParams(window.location.search).get("run");
    return (
      saved ||
      (bootstrap.latestRun &&
      !bootstrap.latestRun.requestedArtifactKinds.includes("prototype")
        ? bootstrap.latestRun.id
        : "")
    );
  });
  const direct = useStudioRun(projectId, directRunId);
  const directRunning =
    isActiveRun(direct.run) ||
    Boolean(directRunId && !direct.run && !direct.error);

  const feedbackRecord = useStudioStoredRecord(
    studioRecordKey(user?.id, projectId, "feedback"),
    feedbackCommandSchema,
  );
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();

  const [interaction, setInteraction] = useState<PrototypePreviewInteraction>();

  const requirementContext: RequirementContext =
    inputContext?.target.kind === "revision"
      ? {
          kind: "revision",
          revisionId: inputContext.target.id,
          feedbackIds: inputContext.target.feedbackIds ?? [],
          anchor:
            interaction?.revisionId === inputContext.target.id &&
            selectedRevisionId === inputContext.target.id
              ? {
                  sourceRevisionId: interaction.revisionId,
                  scope: "node",
                  pageId: interaction.pageId,
                  nodeId: interaction.nodeId,
                  quote: interaction.label,
                }
              : null,
        }
      : { kind: "new" };
  const discussionKey = `${composerEntry.context.key}:${canonicalJson(requirementContext)}`;
  const activeDiscussion = useRef(discussionKey);
  activeDiscussion.current = discussionKey;
  const initialRequest = inputContext?.operationRequest;
  const discussion = useRequirementDiscussion({
    projectId,
    threadId: bootstrap.selectedThreadId ?? "",
    context: requirementContext,
    contextKey: discussionKey,
    canEdit,
    enabled: composerSession.ready,
    operation: {
      workflow:
        artifactContext?.workflow ?? initialRequest?.workflow ?? "generate",
      artifactTargets:
        artifactContext?.artifactTargets ??
        initialRequest?.artifactTargets ??
        [],
      generationIntent:
        artifactContext?.generationIntent ??
        initialRequest?.generationIntent ??
        null,
      prdScreenPlan:
        artifactContext?.prdScreenPlan ?? initialRequest?.prdScreenPlan,
    },
  });
  const discussedInput = discussion.snapshot?.generationRequest;
  const configDirty =
    !!discussedInput &&
    canonicalJson({
      modelId: composerEntry.draft.modelId,
      targetSurface: composerEntry.draft.targetSurface,
      designStyle: composerEntry.draft.designStyle,
      sourceIds: [...composerEntry.draft.sourceIds].sort(),
      requestedArtifactKinds: [
        ...composerEntry.draft.requestedArtifactKinds,
      ].sort(),
    }) !==
      canonicalJson({
        modelId: discussedInput.modelId,
        targetSurface: discussedInput.targetSurface,
        designStyle: discussedInput.designStyle,
        sourceIds: [...discussedInput.sourceIds].sort(),
        requestedArtifactKinds: [
          ...discussedInput.requestedArtifactKinds,
        ].sort(),
      });
  const discussionView = requirementView(discussion.snapshot, {
    scopeKey: `${user?.id ?? ""}:${projectId}:${discussionKey}`,
    contextLabel:
      composerEntry.context.kind === "new"
        ? "本项目的新需求"
        : `${composerEntry.context.title}${requirementContext.kind === "revision" ? ` · ${requirementContext.feedbackIds.length} 条所选批注${requirementContext.anchor ? ` · 元素：${requirementContext.anchor.quote}` : ""}` : ""}`,
    entries: discussion.messages,
    pendingConfirmation:
      discussion.command?.kind === "confirm" ||
      discussion.command?.kind === "dispatch",
    hasMore: discussion.hasMore,
    generationBaseline: discussion.generationBaseline,
  });
  discussionView.reviewCurrent =
    discussionView.reviewCurrent &&
    !discussion.requiresReview &&
    !discussion.pending &&
    !composerSession.sourcePending;
  discussionView.canConfirm =
    discussionView.canConfirm && !composerSession.sourcePending;
  const discussionDirty =
    !!composerEntry.draft.prompt.trim() ||
    !!composerEntry.draft.files.length ||
    !!composerEntry.draft.missingFiles.length ||
    configDirty;

  const awaitingPlan = useRef<string | undefined>(undefined);
  const [lastDraftPage, setLastDraftPage] = useState<{ planId: string; pageId: string }>();
  const rememberDraftPage = useCallback(
    (pageId: string) => setLastDraftPage({ planId, pageId }),
    [planId],
  );
  const followedDraftPage =
    followRun && lastDraftPage?.planId === planId ? lastDraftPage.pageId : undefined;
  const plansQuery = useWorkbenchPrototypeV2Plans(projectId);
  const planQuery = useWorkbenchPrototypeV2Plan(projectId, planId);
  const directRevisionQuery = useWorkbenchPrototypeV2Revision(
    projectId,
    selectedRevisionId,
  );
  const refetchRevision = directRevisionQuery.refetch;
  const plan = planQuery.data?.value;
  const rootPlanId =
    plan?.rootPlanId ??
    plan?.id ??
    directRevisionQuery.data?.value.planId ??
    "";
  const revisionsQuery = useWorkbenchPrototypeV2Revisions(
    projectId,
    rootPlanId,
    Boolean(rootPlanId),
  );
  const revisions = revisionsQuery.data ?? [];
  const selectedSummary = revisions.find(
    (revision) => revision.id === selectedRevisionId,
  );
  const selectedRevision = directRevisionQuery.data?.value;
  const selectedRevisionPlan = plansQuery.data?.find(
    (candidate) =>
      (candidate.rootPlanId ?? candidate.id) === selectedRevision?.planId &&
      candidate.contentVersion === selectedRevision.version,
  );
  const pages = useMemo(
    () =>
      selectedRevision
        ? [...selectedRevision.pages].sort((a, b) => a.order - b.order)
        : [],
    [selectedRevision],
  );
  const selectedPage =
    pages.find((page) => page.id === selectedPageId) ?? pages[0];
  const feedbackRevisionId = feedbackSourceId || selectedRevision?.id || "";
  const feedbackPageId =
    feedbackFilter === "page" ? selectedPage?.id : undefined;
  const feedbackStatus =
    feedbackFilter === "open" || feedbackFilter === "resolved"
      ? feedbackFilter
      : undefined;
  const locationsQuery = useInfiniteQuery({
    queryKey: [
      ...workbenchQueryKeys.prototypeV2(projectId),
      "feedback-locations",
      selectedRevisionId,
      feedbackRevisionId,
      feedbackStatus,
      feedbackPageId,
    ],
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: PrototypeFeedbackLocations) =>
      page.nextCursor ?? undefined,
    queryFn: ({ pageParam }) =>
      api.feedbackLocations(projectId, selectedRevisionId, feedbackRevisionId, {
        cursor: pageParam,
        limit: 50,
        status: feedbackStatus,
        pageId: feedbackPageId,
      }),
    enabled: Boolean(
      selectedRevisionId && feedbackRevisionId && panel === "feedback",
    ),
    refetchInterval: panel === "feedback" ? 3000 : false,
  });
  const feedbackLocations =
    locationsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const feedbackQuery = {
    data: [
      ...new Map(
        feedbackLocations.map((item) => [item.feedback.id, item.feedback]),
      ).values(),
    ],
    error: locationsQuery.error,
  };
  const sharesQuery = useWorkbenchPrototypeV2Shares(projectId);
  const exportsQuery = useWorkbenchPrototypeV2Exports(projectId);
  const createPreviewToken = useCreateWorkbenchPrototypeV2PreviewToken(
    projectId,
    selectedRevision?.id ?? "",
  );
  const cancelPlan = useCancelWorkbenchPrototypeV2Plan(projectId, planId);
  const retryPlan = useRetryWorkbenchPrototypeV2Plan(projectId, planId);
  const createFeedback = useCreateWorkbenchPrototypeV2Feedback(
    projectId,
    selectedRevision?.id ?? "",
  );
  const createShare = useCreateWorkbenchPrototypeV2Share(projectId);
  const createExport = useCreateWorkbenchPrototypeV2Export(projectId);
  const confirmRevision = useReviewWorkbenchPrototypeV2Revision(
    projectId,
    selectedRevision?.id ?? "",
    "confirm",
  );
  const rejectRevision = useReviewWorkbenchPrototypeV2Revision(
    projectId,
    selectedRevision?.id ?? "",
    "reject",
  );
  const ready = Boolean(
    selectedRevision &&
      ["ready", "confirmed"].includes(selectedRevision.status),
  );
  const editingCurrent = inputContext?.target.kind === "revision";
  const running = Boolean(
    plan && ["approved", "generating"].includes(plan.status),
  );
  const baseline = discussion.generationBaseline;
  if (discussionView.status === "generating" && baseline?.status === "started") {
    const outcome = baseline.planId
      ? plan?.id === baseline.planId ? plan.status : undefined
      : direct.run?.id === baseline.runId ? direct.run?.status : undefined;
    if (outcome === "ready") discussionView.generationOutcome = "succeeded";
    else if (outcome === "succeeded" || outcome === "failed" || outcome === "cancelled")
      discussionView.generationOutcome = outcome;
  }
  const previousRevision = revisions.find(
    (revision) => revision.id === selectedRevision?.sourceRevisionId,
  );
  const diffQuery = useWorkbenchPrototypeV2RevisionDiff(
    projectId,
    selectedRevision?.id ?? "",
  );

  const previews = Object.values(progress.projection?.generationPreviews ?? {});
  const showingDraft = followRun && (
    running ||
    (previews.length > 0 && (
      !selectedRevision?.previewHtml ||
      (Boolean(followedDraftPage) &&
        plan?.status === "ready" &&
        selectedRevision.version !== plan.contentVersion)
    ))
  );
  const elapsed = progress.snapshot?.run?.startedAt
    ? Math.max(
        0,
        Math.floor(
          (clock - Date.parse(progress.snapshot.run.startedAt)) / 1000,
        ),
      )
    : 0;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    setFeedbackIds([]);
    setFeedbackSourceId("");
    setFeedbackScope("version");
    setFeedbackLocation(undefined);
    setFeedback("");
    setInteraction(undefined);
  }, [selectedRevisionId]);
  useEffect(() => {
    const restore = () => {
      setSelection(readPrototypeSelection(window.location.search));
      setViewState(readView());
      setDirectRunId(
        new URLSearchParams(window.location.search).get("run") ?? "",
      );
    };
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("popstate", restore);
    };
  }, []);
  useEffect(() => {
    if (!planId && directRevisionQuery.data && plansQuery.data)
      setSelection((current) => ({
        ...current,
        planId:
          selectedRevisionPlan?.id ?? directRevisionQuery.data.value.planId,
      }));
    else if (!planId && !selectedRevisionId && plansQuery.data?.length)
      setSelection((current) => ({
        ...current,
        planId: plansQuery.data[0]!.id,
      }));
    // Revisions belong to the history root. A copied root/revision URL must show
    // the child plan that generated that content version, including after retry.
    else if (
      selectedRevisionPlan &&
      selectedRevision &&
      plan?.id === planId &&
      planId === selectedRevision.planId &&
      planId !== selectedRevisionPlan.id &&
      !running &&
      !followedDraftPage &&
      !awaitingPlan.current
    )
      setSelection((current) => ({
        ...current,
        planId: selectedRevisionPlan.id,
      }));
  }, [
    directRevisionQuery.data,
    followedDraftPage,
    plan?.id,
    planId,
    plansQuery.data,
    running,
    selectedRevision,
    selectedRevisionId,
    selectedRevisionPlan?.id,
  ]);
  useEffect(() => {
    if (!revisions.length) return;
    const generated =
      plan?.status === "ready" && (awaitingPlan.current === plan.id || followedDraftPage)
        ? revisions.find((revision) => revision.version === plan.contentVersion)
        : undefined;
    if (generated) {
      awaitingPlan.current = undefined;
      setLastDraftPage(undefined);
      if (generated.id !== selectedRevisionId)
        setSelection((current) => ({
          ...current,
          revisionId: generated.id,
          pageId: followedDraftPage ?? current.pageId,
        }));
    } else if (!selectedRevisionId) {
      const latest = revisions[revisions.length - 1]!;
      setSelection((current) => ({
        ...current,
        revisionId: latest.id,
        pageId: "",
      }));
    }
  }, [followedDraftPage, plan, revisions, selectedRevisionId]);
  useEffect(() => {
    if (
      selectedSummary &&
      selectedRevision &&
      selectedSummary.revision !== selectedRevision.revision
    )
      void refetchRevision();
  }, [refetchRevision, selectedRevision?.revision, selectedSummary?.revision]);
  useEffect(() => {
    if (
      selectedRevision &&
      !showingDraft &&
      !pages.some((page) => page.id === selectedPageId)
    )
      setSelection((current) => ({ ...current, pageId: pages[0]?.id ?? "" }));
  }, [pages, selectedPageId, selectedRevision, showingDraft]);
  useEffect(() => {
    if (planId || selectedRevisionId) writePrototypeSelection(selection);
  }, [planId, selectedRevisionId, selection]);
  useEffect(() => {
    setPreviewUrl(undefined);
  }, [selectedRevisionId]);

  const queryError =
    planQuery.error ||
    directRevisionQuery.error ||
    plansQuery.error ||
    revisionsQuery.error ||
    feedbackQuery.error ||
    sharesQuery.error ||
    exportsQuery.error ||
    diffQuery.error;
  const run = async (operation: () => Promise<unknown>, success: string) => {
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await operation();
      if (result !== false) setMessage(success);
    } catch (cause) {
      if (isWorkbenchApiError(cause) && [409, 412].includes(cause.status)) {
        await queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.prototypeV2(projectId),
        });
        setError(
          "状态已被其他操作更新，已重新加载。请核对最新内容后重试，输入文字仍保留。",
        );
      } else setError(cause instanceof Error ? cause.message : "操作失败");
    }
  };
  const selectPlan = (next: PrototypePlan) => {
    setFollowRun(true);
    awaitingPlan.current = undefined;
    setSelection({ planId: next.id, revisionId: "", pageId: "" });
  };
  const queueArtifactPrompt = (
    text: string,
    context?: StudioArtifactContext,
  ) => {
    composerSession.switchTo(
      context
        ? {
            kind: "artifact",
            key: `artifact:${JSON.stringify({
              workflow: context.workflow,
              generationIntent: context.generationIntent ?? null,
              prdScreenPlan: context.prdScreenPlan ?? null,
              targets: context.artifactTargets,
            })}`,
            title: `${artifactPromptLabel(context)}：${context.title}`,
            artifact: context,
          }
        : composerSession.newContext,
      text,
    );
    setInteraction(undefined);
    setPanel(null);
    setFocused(false);
  };
  const submitPlan: StudioComposerProps["onSubmit"] = async (submission) => {
    if (composerSession.isSelectingSource())
      throw new Error("正在读取固定来源，请稍候再发送。");
    const entryKey = composerEntry.context.key;
    const submittedDraft = composerEntry.draft;
    const scope = discussionKey;
    setError(undefined);
    const accepted = await discussion.send({
      ...submission,
      onFileSource: (file, sourceId) =>
        composerSession.bindFileSource(entryKey, file, sourceId),
    });
    if (!accepted || activeDiscussion.current !== scope) return null;
    composerSession.complete(entryKey, submittedDraft, true);
    setMessage("需求已保存，正在梳理本次改动；确认前不会启动生成");
    return accepted.id;
  };
  const openedConfirmations = useRef(new Set<string>());
  const expectedGeneration = useRef<string | undefined>(undefined);
  expectedGeneration.current = discussion.generationResult?.id;
  useEffect(() => {
    const receipt = discussion.generationResult;
    if (
      receipt?.status !== "started" ||
      openedConfirmations.current.has(receipt.id)
    )
      return;
    const scope = discussionKey;
    openedConfirmations.current.add(receipt.id);
    const open = async () => {
      try {
        if (receipt.planId) {
          const accepted = await api.getPlan(projectId, receipt.planId);
          if (
            activeDiscussion.current !== scope ||
            expectedGeneration.current !== receipt.id
          )
            return;
          if (
            accepted.value.projectId !== projectId ||
            accepted.value.id !== receipt.planId
          )
            throw new Error("生成回执与当前项目不匹配");
          queryClient.setQueryData(
            workbenchQueryKeys.prototypeV2Plan(projectId, accepted.value.id),
            accepted,
          );
          awaitingPlan.current = accepted.value.id;
          setSelection({
            planId: accepted.value.id,
            revisionId: "",
            pageId: "",
          });
          setFollowRun(true);
          setView("pages");
          setPanel((current) => current === "plan" ? current : null);
          void queryClient.invalidateQueries({
            queryKey: workbenchQueryKeys.prototypeV2(projectId),
          });
        } else if (receipt.runId) {
          if (
            activeDiscussion.current !== scope ||
            expectedGeneration.current !== receipt.id
          )
            return;
          setDirectRunId(receipt.runId);
          const url = new URL(window.location.href);
          url.searchParams.set("run", receipt.runId);
          window.history.replaceState(null, "", url);
          setView("documents");
        } else
          throw new Error("生成已受理，正在等待计划或运行标识，请刷新需求状态");
        discussion.acknowledgeResult();
      } catch (cause) {
        if (activeDiscussion.current === scope)
          setError(
            cause instanceof Error
              ? cause.message
              : "无法打开本次生成，请刷新需求状态",
          );
        openedConfirmations.current.delete(receipt.id);
      }
    };
    void open();
  }, [api, projectId, queryClient, discussion, discussionKey]);
  const addFeedback = () =>
    run(async () => {
      if (!selectedRevision) return;
      const pageId = interaction?.pageId || selectedPage?.id;
      const anchor =
        interaction && pageId
          ? {
              scope: "node" as const,
              sourceRevisionId: interaction.revisionId,
              pageId,
              nodeId: interaction.nodeId,
              quote: interaction.label,
            }
          : feedbackScope === "page" && selectedPage && selectedRevision
            ? {
                scope: "page" as const,
                sourceRevisionId: selectedRevision.id,
                pageId: selectedPage.id,
                quote: selectedPage.title,
              }
            : null;
      const request = createPrototypeFeedbackRequestSchema.parse({
        body: feedback.trim(),
        anchor,
      });
      const signature = canonicalJson({
        projectId,
        revisionId: selectedRevision.id,
        request,
      });
      const command =
        feedbackRecord.value?.signature === signature
          ? feedbackRecord.value
          : {
              version: 1 as const,
              signature,
              key: createIdempotencyKey("prototype-feedback"),
              revisionId: selectedRevision.id,
              request,
            };
      feedbackRecord.save(command);
      await createFeedback.mutateAsync({
        idempotencyKey: command.key,
        request: command.request,
      });
      if (!feedbackRecord.isCurrent()) return;
      feedbackRecord.clear();
      setFeedbackFilter("all");
      setFeedbackSourceId(selectedRevision.id);
      setFeedback((current) => (current === feedback ? "" : current));
    }, "批注已保存到当前版本");

  const confirmSavedFeedback = () =>
    run(async () => {
      const command = feedbackRecord.value;
      if (!command || command.revisionId !== selectedRevision?.id) return;
      await createFeedback.mutateAsync({
        idempotencyKey: command.key,
        request: command.request,
      });
      if (!feedbackRecord.isCurrent()) return;
      feedbackRecord.clear();
      setFeedbackFilter("all");
      setFeedbackSourceId(command.revisionId);
    }, "上次批注保存已确认");

  const chooseRevision = (id: string) => {
    const revision = revisions.find((item) => item.id === id);
    if (!revision) return;
    awaitingPlan.current = undefined;
    setFollowRun(false);
    const owner = plansQuery.data?.find(
      (candidate) =>
        (candidate.rootPlanId ?? candidate.id) === revision.planId &&
        candidate.contentVersion === revision.version,
    );
    setSelection({
      planId: owner?.id ?? revision.planId,
      revisionId: id,
      pageId: "",
    });
  };
  const visibleFeedback = feedbackQuery.data;
  const panelContent = (
    <div className="visual-context studio-panel-content">
      {" "}
      {panel === "plan" && (
        <>
          <label>
            选择原型计划
            <select
              aria-label="选择原型计划"
              value={planId}
              onChange={(e) => {
                const item = plansQuery.data?.find(
                  (p) => p.id === e.target.value,
                );
                if (item) selectPlan(item);
              }}
            >
              <option value="">新建计划</option>
              {plansQuery.data?.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} · {planStatusLabel(item.status)}
                </option>
              ))}
            </select>
          </label>
          {plansQuery.data?.length === 100 && (
            <p className="visual-muted">显示最近 100 个计划</p>
          )}
          {plan ? (
            <article className="visual-card">
              <strong>{plan.title}</strong>
              <p className="visual-prose">{plan.prompt}</p>
              <p role="status">{planStatusLabel(plan.status)}</p>
              {livePlanRun && livePlanRun.status !== "waiting_input" && (
                <RunOutputs run={livePlanRun} />
              )}
              <PlanInputSummary projectId={projectId} plan={plan} />
              {livePlanRun?.status === "waiting_input" && (
                <RunDetails
                  run={livePlanRun!}
                  projection={progress.projection}
                  canEdit={canEdit}
                />
              )}{" "}
              {plan.failure && (
                <p role="alert">
                  {plan.failure.detail}
                  <small>诊断：{plan.failure.code}</small>
                </p>
              )}
              <div className="visual-actions">
                {running && (
                  <button
                    type="button"
                    disabled={!canEdit || cancelPlan.isPending}
                    onClick={() =>
                      void run(
                        () =>
                          cancelPlan.mutateAsync({
                            ifMatch: etag(plan),
                            request: {},
                          }),
                        "停止请求已提交，等待运行确认",
                      )
                    }
                  >
                    停止生成
                  </button>
                )}
                {["failed", "cancelled"].includes(plan.status) && (
                  <button
                    type="button"
                    disabled={!canEdit || retryPlan.isPending}
                    onClick={() =>
                      void run(async () => {
                        const next = await retryPlan.mutateAsync({
                          ifMatch: etag(plan),
                          request: {},
                        });
                        awaitingPlan.current = next.value.id;
                        setFollowRun(true);
                        setSelection((current) => ({
                          ...current,
                          planId: next.value.id,
                        }));
                      }, "已使用原输入重试生成")
                    }
                  >
                    重试生成
                  </button>
                )}
              </div>
            </article>
          ) : (
            <p className="visual-muted">
              从下方交流需求，核对改动摘要后确认生成。在这里查看已确认的固定输入。
            </p>
          )}
        </>
      )}
      {panel === "versions" && (
        <>
          {selectedRevision && (
            <RevisionRelations
              projectId={projectId}
              revision={selectedRevision}
              pageId={selectedPage?.id}
              onPrompt={canEdit ? queueArtifactPrompt : undefined}
            />
          )}
          {revisions.length === 0 && <p>尚无生成版本</p>}
          {[...revisions].reverse().map((revision) => (
            <button
              key={revision.id}
              type="button"
              className="visual-version"
              aria-pressed={selectedRevisionId === revision.id}
              onClick={() => chooseRevision(revision.id)}
            >
              <strong>
                版本 {revision.version} · {statusLabel(revision.status)}
              </strong>
              <span>{revision.title}</span>
              <time>
                {new Date(revision.createdAt).toLocaleString("zh-CN")}
              </time>
            </button>
          ))}
          {selectedRevision?.status === "ready" && (
            <div className="visual-actions">
              <button
                type="button"
                disabled={!canEdit || confirmRevision.isPending}
                onClick={() =>
                  void run(
                    () =>
                      confirmRevision.mutateAsync({
                        ifMatch: etag(selectedRevision),
                        request: {},
                      }),
                    "版本已确认",
                  )
                }
              >
                确认版本
              </button>
              <button
                type="button"
                disabled={!canEdit || rejectRevision.isPending}
                onClick={() =>
                  void run(
                    () =>
                      rejectRevision.mutateAsync({
                        ifMatch: etag(selectedRevision),
                        request: {},
                      }),
                    "版本已驳回",
                  )
                }
              >
                驳回版本
              </button>
            </div>
          )}
          {diffQuery.data?.sourceRevisionId && (
            <article className="visual-card">
              <h3>
                与
                {previousRevision
                  ? `版本 ${previousRevision.version}`
                  : "来源版本"}
                比较
              </h3>
              {diffQuery.data.pages.map((item) => (
                <p key={item.pageId}>
                  {
                    {
                      added: "＋ 新增",
                      removed: "− 删除",
                      changed: "↻ 修改",
                      unchanged: "＝ 未变",
                    }[item.change]
                  }{" "}
                  ·{" "}
                  {pages.find((p) => p.id === item.pageId)?.title ??
                    item.pageId}
                </p>
              ))}
            </article>
          )}
        </>
      )}
      {panel === "feedback" && (
        <>
          {selectedRevision ? (
            <>
              <p>
                新批注绑定版本 {selectedRevision.version} ·{" "}
                {interaction?.label ||
                  (feedbackScope === "page" ? selectedPage?.title : "版本整体")}
              </p>
              <label>
                批注范围
                <select
                  aria-label="批注范围"
                  value={interaction ? "node" : feedbackScope}
                  onChange={(event) => {
                    if (event.target.value !== "node") {
                      setInteraction(undefined);
                      setFeedbackScope(
                        event.target.value as "page" | "version",
                      );
                    }
                  }}
                >
                  <option value="version">版本整体</option>
                  <option value="page" disabled={!selectedPage}>
                    当前页面
                  </option>
                  {interaction && <option value="node">选中元素</option>}
                </select>
              </label>
              <textarea
                aria-label="当前版本批注"
                maxLength={4000}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                disabled={!canEdit}
                placeholder="写下需要调整的内容"
              />
              <div className="visual-actions">
                <button
                  type="button"
                  disabled={
                    !canEdit || !feedback.trim() || createFeedback.isPending
                  }
                  onClick={() => void addFeedback()}
                >
                  保存批注
                </button>
                {interaction && (
                  <button
                    type="button"
                    onClick={() => setInteraction(undefined)}
                  >
                    清除元素上下文
                  </button>
                )}
              </div>
              {feedbackRecord.value &&
                feedbackRecord.value.revisionId === selectedRevision.id && (
                  <div className="studio-link-pending" role="status">
                    <p>
                      已保留未确认的批注保存：
                      {feedbackRecord.value.request.body}
                    </p>
                    <div className="visual-actions">
                      <button
                        type="button"
                        disabled={!canEdit || createFeedback.isPending}
                        onClick={() => void confirmSavedFeedback()}
                      >
                        确认上次批注保存
                      </button>
                      <button
                        type="button"
                        disabled={!canEdit || createFeedback.isPending}
                        onClick={() => feedbackRecord.clear()}
                      >
                        放弃批注记录
                      </button>
                    </div>
                  </div>
                )}
              <label>
                查看批注来源
                <select
                  aria-label="批注来源版本"
                  value={feedbackRevisionId}
                  onChange={(event) => {
                    setFeedbackSourceId(event.target.value);
                    setFeedbackIds([]);
                  }}
                >
                  {revisions.map((revision) => (
                    <option key={revision.id} value={revision.id}>
                      版本 {revision.version}
                      {revision.id === selectedRevision.id ? "（当前）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {feedbackRevisionId !== selectedRevision.id && (
                <p>
                  正在对照来源版本的批注；正文与源锚点保持原样。
                  <button onClick={() => chooseRevision(feedbackRevisionId)}>
                    打开批注来源版本
                  </button>
                </p>
              )}
              <label>
                筛选
                <select
                  aria-label="批注筛选"
                  value={feedbackFilter}
                  onChange={(e) => setFeedbackFilter(e.target.value)}
                >
                  <option value="all">全部</option>
                  <option value="page">当前页面</option>
                  <option value="open">未解决</option>
                  <option value="resolved">已解决</option>
                </select>
              </label>
              <p className="visual-muted">
                已载入 {visibleFeedback.length}{" "}
                条，按最新保存排序。筛选覆盖此来源版本的全部批注。
              </p>
              {locationsQuery.isLoading && (
                <p className="visual-muted" role="status">
                  正在读取批注…
                </p>
              )}
              {!locationsQuery.isLoading &&
                !locationsQuery.error &&
                visibleFeedback.length === 0 && (
                  <p className="visual-muted">暂无批注</p>
                )}
              {visibleFeedback.map((item) => (
                <div key={item.id} className="visual-feedback">
                  <label>
                    <input
                      type="checkbox"
                      disabled={
                        !canEdit ||
                        item.status !== "open" ||
                        (feedbackIds.length >= 100 &&
                          !feedbackIds.includes(item.id)) ||
                        feedbackRevisionId !== selectedRevision.id
                      }
                      checked={feedbackIds.includes(item.id)}
                      onChange={(e) =>
                        setFeedbackIds((ids) =>
                          e.target.checked
                            ? [...ids, item.id]
                            : ids.filter((id) => id !== item.id),
                        )
                      }
                    />
                    用于本次修改
                  </label>
                  <FeedbackRow
                    item={item}
                    canEdit={canEdit}
                    run={run}
                    location={feedbackLocations.find(
                      (location) => location.feedback.id === item.id,
                    )}
                    onLocate={(location) => {
                      if (location.status !== "resolved" || !location.pageId)
                        return;
                      setFollowRun(false);
                      setView("pages");
                      setFeedbackLocation({
                        revisionId: location.targetRevisionId,
                        pageId: location.pageId,
                        nodeId: location.nodeId,
                        requestId: crypto.randomUUID(),
                      });
                    }}
                  />
                </div>
              ))}
              {locationsQuery.hasNextPage && (
                <button
                  type="button"
                  disabled={locationsQuery.isFetchingNextPage}
                  onClick={() => void locationsQuery.fetchNextPage()}
                >
                  {locationsQuery.isFetchingNextPage
                    ? "正在载入…"
                    : "加载更多批注"}
                </button>
              )}
              {locationsQuery.error && (
                <button
                  type="button"
                  onClick={() => void locationsQuery.refetch()}
                >
                  重试读取批注
                </button>
              )}
              {feedbackIds.length > 0 && (
                <button type="button" onClick={() => setFeedbackIds([])}>
                  清空所选批注（{feedbackIds.length} 条，含其他筛选结果）
                </button>
              )}
              <button
                type="button"
                disabled={
                  !canEdit ||
                  feedbackRevisionId !== selectedRevision.id ||
                  !feedbackIds.length ||
                  feedbackIds.length > 100 ||
                  running ||
                  discussion.pending
                }
                onClick={() =>
                  void run(async () => {
                    const applied = await composerSession.selectSource(async () => {
                      const input = await api.getRevisionInput(
                        projectId,
                        selectedRevision.id,
                      );
                      const selected = [...feedbackIds].sort();
                      return [
                        {
                          kind: "input",
                          key: `revision:${selectedRevision.id}:feedback:${selected.join(",")}`,
                          title: `修改版本 ${selectedRevision.version}`,
                          target: {
                            kind: "revision",
                            id: selectedRevision.id,
                            etag: etag(selectedRevision),
                            feedbackIds: selected,
                          },
                          input: {
                            plan: input.plan,
                            request: input.request,
                            snapshot: input.snapshot,
                            sha256: input.sha256,
                          },
                          operationRequest: input.modificationRequest,
                          version: selectedRevision.version,
                        },
                        "请根据所选批注梳理本次增量改动",
                      ];
                    });
                    if (!applied) return false;
                    setInteraction(undefined);
                    setPanel(null);
                  }, "已将所选批注带入需求讨论，尚未启动生成")
                }
              >
                讨论所选 {feedbackIds.length} 条批注
              </button>
              <p className="visual-muted">
                一次最多 100
                条；沿用源计划资料与设计上下文。生成不会自动解决批注。
              </p>
            </>
          ) : (
            <p>选择一个版本后查看或添加批注。</p>
          )}
        </>
      )}
      {panel === "delivery" && (
        <>
          {selectedRevision ? (
            <>
              <p>交付绑定版本 {selectedRevision.version}</p>
              <label>
                分享有效期
                <select
                  value={expiry}
                  disabled={!!shareRecord.value || shareFlight.current}
                  onChange={(e) => setExpiry(e.target.value)}
                >
                  <option value="7">7 天</option>
                  <option value="30">30 天</option>
                  <option value="0">长期有效</option>
                </select>
              </label>
              <button
                type="button"
                disabled={!canEdit || !ready || createShare.isPending || !shareRecord.ready || !!shareRecord.error}
                onClick={() =>
                  void run(
                    async () => {
                      if (shareFlight.current) return false;
                      shareFlight.current = true;
                      try {
                        const command = shareRecord.value ?? {
                          version: 1 as const,
                          key: createIdempotencyKey("studio-share"),
                          request: {
                          revisionId: selectedRevision.id,
                          expiresAt:
                            expiry === "0"
                              ? null
                              : new Date(
                                  Date.now() + Number(expiry) * 86400000,
                                ).toISOString(),
                          },
                        };
                        if (!shareRecord.value && !shareRecord.save(command))
                          throw new Error("无法保存本次分享动作，请恢复浏览器存储后再试。");
                        const result = await createShare.mutateAsync({
                          request: command.request,
                          idempotencyKey: command.key,
                        });
                        if (!shareRecord.isCurrent()) return false;
                        if (result.value.projectId !== projectId || result.value.revisionId !== command.request.revisionId)
                          throw new Error("分享回执与固定版本不匹配，请恢复原操作。");
                        shareRecord.clear();
                      } finally { shareFlight.current = false; }
                    },
                    "分享链接已创建",
                  )
                }
              >
                {shareRecord.value ? "恢复分享结果" : "创建分享"}
              </button>
              {shareRecord.error && <p role="alert">{shareRecord.error}</p>}
              {shareRecord.value && <p>
                上次创建分享的结果尚未核实，恢复会沿用原版本、到期时间和操作编号。
                <button disabled={createShare.isPending} onClick={() => shareRecord.clear()}>放弃恢复</button>
                放弃恢复不会撤销可能已创建的链接，可在下方核对后撤销。
              </p>}
              <div className="visual-actions">
                {(["html", "react"] as const).map((format) => (
                  <button
                    key={format}
                    type="button"
                    disabled={!canEdit || !ready || createExport.isPending}
                    onClick={() =>
                      void run(
                        () =>
                          createExport.mutateAsync({
                            request: {
                              revisionId: selectedRevision.id,
                              format,
                            },
                          }),
                        `${format.toUpperCase()} 导出已排队`,
                      )
                    }
                  >
                    导出 {format === "html" ? "HTML" : "React"}
                  </button>
                ))}
              </div>
              <p className="visual-muted">
                HTML 可直接打开；React 为源码包。完成后将提供实际文件下载。
              </p>
              <button
                type="button"
                disabled={!ready || createPreviewToken.isPending}
                onClick={() =>
                  void run(async () => {
                    const result = await createPreviewToken.mutateAsync();
                    setPreviewUrl(result.url);
                  }, "隔离预览链接已创建")
                }
              >
                安全预览链接
              </button>
              {previewUrl && (
                <a href={previewUrl} target="_blank" rel="noreferrer">
                  打开隔离预览
                </a>
              )}
              {sharesQuery.data
                ?.filter((item) => item.revisionId === selectedRevision.id)
                .map((item) => (
                  <ShareRow
                    key={item.id}
                    item={item}
                    projectId={projectId}
                    canEdit={canEdit}
                    run={run}
                  />
                ))}
              {exportsQuery.data
                ?.filter((item) => item.revisionId === selectedRevision.id)
                .map((item) => (
                  <ExportRow
                    key={item.id}
                    item={item}
                    projectId={projectId}
                    canEdit={canEdit}
                    run={run}
                  />
                ))}
            </>
          ) : (
            <p>生成完成后，可分享或导出该版本。</p>
          )}
        </>
      )}
      {!canEdit && (
        <p className="visual-notice">当前为只读权限，可浏览和下载已有成果。</p>
      )}
    </div>
  );
  const navigation = [
    { value: "pages", label: "页面", icon: <PanelsTopLeft size={19} /> },
    { value: "documents", label: "文档", icon: <FileText size={19} /> },
    { value: "resources", label: "资料", icon: <FolderOpen size={19} /> },
    { value: "knowledge", label: "知识", icon: <BookOpen size={19} /> },
    { value: "runs", label: "运行", icon: <Activity size={19} /> },
    { value: "publishing", label: "发布", icon: <CloudUpload size={19} /> },
    { value: "project", label: "项目", icon: <Settings size={19} /> },
    {
      value: "plan",
      label: "计划",
      icon: <ListTodo size={19} />,
      content: panelContent,
    },
    {
      value: "versions",
      label: "版本",
      icon: <History size={19} />,
      content: panelContent,
    },
    {
      value: "feedback",
      label: "批注",
      icon: <MessageSquare size={19} />,
      content: panelContent,
    },
    {
      value: "delivery",
      label: "交付",
      icon: <Send size={19} />,
      content: panelContent,
    },
  ];
  return (
    <div className="visual-workspace studio-workspace" data-studio-workspace>
      <Main
        topBar={
          <>
            <Link href="/" prefetch={false} className="studio-wordmark" aria-label="项目首页">
              W<span>工作台</span>
            </Link>
            <div className="studio-project-title">
              <strong>{bootstrap.project.title}</strong>
              <span>
                {selectedRevision
                  ? `版本 ${selectedRevision.version} · ${statusLabel(selectedRevision.status)}`
                  : "需求文档与交互原型"}
              </span>
            </div>
            <div className="studio-top-actions">
              <button
                onClick={(event) => {
                  setView("pages");
                  openPanel("versions", event.currentTarget);
                }}
              >
                版本
              </button>
              <button onClick={(event) => openPanel("delivery", event.currentTarget)}>分享 / 导出</button>
            </div>
          </>
        }
        leftPanel={
          <DesignPanel
            tabs={navigation}
            selectedTab={panel ?? view}
            panelTrigger={panelTrigger}
            onSelect={(value, trigger) => {
              if (
                ["plan", "versions", "feedback", "delivery"].includes(
                  value ?? "",
                )
              )
                openPanel(value as StudioPanel, trigger);
              else {
                setPanel(null);
                if (value) setView(value as StudioView);
              }
            }}
          />
        }
        canvas={
          <>
            {directRunId && (
              <details
                className="studio-direct-run"
                open={direct.run?.status === "waiting_input"}
              >
                <summary>
                  {direct.run?.status === "waiting_input"
                    ? "需要你的补充输入"
                    : direct.run?.status === "succeeded"
                      ? "文档任务已完成"
                      : direct.run?.status === "failed"
                        ? "文档任务失败"
                        : direct.run?.status === "cancelled"
                          ? "文档任务已停止"
                          : (direct.projection?.phaseLabel ??
                            "文档任务正在执行")}
                  {direct.connection === "connecting" ? " · 正在恢复连接" : ""}
                </summary>
                {Boolean(direct.error) && (
                  <p role="alert">
                    运行状态暂不可用
                    <button onClick={direct.reconnect}>重连</button>
                  </p>
                )}
                {direct.run && (
                  <RunDetails
                    run={direct.run}
                    projection={direct.projection}
                    canEdit={canEdit}
                    onRetried={(next) => {
                      setDirectRunId(next.id);
                      const url = new URL(window.location.href);
                      url.searchParams.set("run", next.id);
                      window.history.replaceState(null, "", url);
                    }}
                  />
                )}
              </details>
            )}
            {(message || error || queryError) && (
              <div
                className="visual-notice"
                role={error || queryError ? "alert" : "status"}
              >
                {error ?? queryError?.message ?? message}
              </div>
            )}
            {progress.snapshot?.finalRevisionId &&
              selectedRevisionId &&
              progress.snapshot.finalRevisionId !== selectedRevisionId && (
                <button
                  type="button"
                  className="visual-result-notice"
                  onClick={() =>
                    chooseRevision(progress.snapshot!.finalRevisionId!)
                  }
                >
                  新结果已就绪 · 打开新版本
                </button>
              )}
            {view === "pages" ? (
              <PageStage
                storageScope={`${user?.id ?? ""}:${projectId}`}
                locate={feedbackLocation}
                draftIdentity={`${planId}:${progress.projection?.attempt ?? 0}`}
                revisionId={selectedRevision?.id ?? "pending"}
                title={selectedRevision?.title ?? "原型页面"}
                html={selectedRevision?.previewHtml}
                pages={pages}
                pageId={selectedPageId}
                onDraftPageShown={rememberDraftPage}
                onPage={(id) => {
                  const next = { ...selection, pageId: id };
                  const url = new URL(window.location.href);
                  url.searchParams.set("page", id);
                  window.history.pushState(null, "", url);
                  setSelection(next);
                }}
                onSelection={(next) => {
                  setInteraction(next);
                  if (next && panel !== "feedback") openPanel("feedback", null);
                }}
                previews={previews}
                showDraft={showingDraft}
                running={running}
              />
            ) : (
              <ProjectViews
                selectedSourceIds={composerEntry.draft.sourceIds}
                onToggleSource={!composer.disabled && canEdit && composerSession.ready && !discussion.pending
                  ? id => composerSession.updateDraft(current => ({
                    ...current, sourceIds: current.sourceIds.includes(id)
                      ? current.sourceIds.filter(sourceId => sourceId !== id)
                      : [...current.sourceIds, id],
                  })) : undefined}
                activeRunId={directRunId}
                previews={
                  directRunning
                    ? Object.values(direct.projection?.generationPreviews ?? {})
                    : []
                }
                view={view}
                bootstrap={bootstrap}
                canEdit={canEdit}
                onPrompt={queueArtifactPrompt}
              />
            )}
          </>
        }
        bottomBar={
          <footer className="visual-composer-dock" data-focused={focused}>
            <div className="studio-composer-status-row">
            {(running || progress.error) && (
              <div className="visual-progress">
                <span className={running ? "visual-pulse" : ""} />
                <span role="status">
                  {progress.connection === "reconnecting"
                    ? "正在恢复连接，保留最后画面"
                    : progress.error
                      ? "进度连接暂不可用"
                      : livePlanRun?.status === "waiting_input"
                        ? "需要补充输入"
                        : (progress.projection?.phaseLabel ?? "正在准备生成")}
                </span>
                {running && (
                  <time>
                    {Math.floor(elapsed / 60)}分{elapsed % 60}秒
                  </time>
                )}
                <button type="button" onClick={(event) => openPanel("plan", event.currentTarget)}>
                  详情
                </button>
                {running && (
                  <button
                    type="button"
                    disabled={!canEdit || cancelPlan.isPending}
                    onClick={() =>
                      void run(
                        () =>
                          cancelPlan.mutateAsync({
                            ifMatch: etag(plan!),
                            request: {},
                          }),
                        "停止请求已提交，等待运行确认",
                      )
                    }
                  >
                    停止
                  </button>
                )}
                {progress.error && (
                  <button type="button" onClick={progress.reconnect}>
                    重连
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              className="visual-focus-toggle"
              onClick={() => setFocused((value) => !value)}
            >
              {focused ? "展开输入框" : "专注预览"}
            </button>
            </div>
            <div hidden={focused}>
              {composerSession.storageError && (
                <p role="alert">{composerSession.storageError}</p>
              )}
              {!composerSession.ready && (
                <p role="status">正在恢复输入与附件…</p>
              )}
              {composerSession.entries
                .filter(
                  (entry) =>
                    entry.context.key !== composerEntry.context.key &&
                    (entry.draft.prompt ||
                      entry.draft.files.length ||
                      entry.draft.missingFiles.length),
                )
                .map((entry) => (
                  <button
                    type="button"
                    key={entry.context.key}
                    onClick={() => composerSession.switchTo(entry.context)}
                  >
                    恢复输入：{entry.context.title}
                  </button>
                ))}
              {(discussion.error || discussion.storageError) && (
                <div role="alert">
                  <p>{discussion.error?.message || discussion.storageError}</p>
                  <button
                    type="button"
                    onClick={() =>
                      void run(discussion.refresh, "已重新读取需求状态")
                    }
                  >
                    重新读取需求状态
                  </button>
                </div>
              )}
              {discussion.command &&
                discussion.command.kind !== "confirm" &&
                discussion.command.kind !== "dispatch" &&
                !discussion.requiresReview && (
                  <button
                    type="button"
                    disabled={discussion.pending || !canEdit}
                    onClick={() =>
                      void run(async () => {
                        await discussion.recover();
                      }, "已核实上次操作回执")
                    }
                  >
                    恢复上次需求操作
                  </button>
                )}
              {discussion.requiresReview && (
                <button
                  type="button"
                  disabled={discussion.pending || !canEdit}
                  onClick={() =>
                    void run(
                      discussion.reviewLatest,
                      "已重新读取，请核对最新改动摘要",
                    )
                  }
                >
                  重新核对最新摘要
                </button>
              )}
              {configDirty && discussedInput && (
                <button
                  type="button"
                  disabled={discussion.pending || !canEdit}
                  onClick={() =>
                    composerSession.updateDraft((current) => ({
                      ...current,
                      modelId: discussedInput.modelId,
                      sourceIds: discussedInput.sourceIds,
                      targetSurface: discussedInput.targetSurface,
                      designStyle: discussedInput.designStyle,
                      requestedArtifactKinds:
                        discussedInput.requestedArtifactKinds,
                    }))
                  }
                >
                  采用已讨论的输入配置
                </button>
              )}
              {discussion.snapshot?.activeTurn &&
                ["queued", "running"].includes(
                  discussion.snapshot.activeTurn.status,
                ) && (
                  <button
                    type="button"
                    disabled={discussion.pending || !canEdit}
                    onClick={() =>
                      void run(async () => {
                        await discussion.turn("cancel");
                      }, "已请求停止需求分析")
                    }
                  >
                    停止需求分析
                  </button>
                )}
              {discussion.snapshot?.activeTurn?.status === "failed" && (
                <div role="status">
                  <p>本次需求分析未完成，输入已保存。</p>
                  <button
                    type="button"
                    disabled={discussion.pending || !canEdit}
                    onClick={() =>
                      void run(async () => {
                        await discussion.turn("retry");
                      }, "已重新提交需求分析")
                    }
                  >
                    重试需求分析
                  </button>
                </div>
              )}
              <RequirementSessions
                items={discussion.directory.map((session) => ({
                  id: session.id,
                  label: session.card?.goal || session.generationRequest.prompt,
                  version: session.summaryVersion,
                }))}
                selectedId={discussion.sessionId}
                hasMore={discussion.hasMoreSessions}
                loading={discussion.loadingSessions}
                disabled={
                  discussion.pending ||
                  !!discussion.command ||
                  discussion.requiresReview
                }
                onSelect={(id) =>
                  void run(async () => {
                    discussion.selectSession(id);
                  }, "已切换需求讨论，未发送的输入仍保留")
                }
                onMore={() =>
                  void run(discussion.loadMoreSessions, "已读取更多需求讨论")
                }
              />
              {composerSession.ready && (
                <RequirementInput
                  generationActive={running || isActiveRun(direct.run)}
                  discussion={{
                    view: discussionView,
                    canEdit,
                    dirtyInput: discussionDirty,
                    onConfirm: async (review) => {
                      if (composerSession.isSelectingSource())
                        throw new Error("正在读取固定来源，请稍候再确认。");
                      await discussion.confirm(review);
                    },
                    onContinue: () => {
                      document
                        .querySelector<HTMLTextAreaElement>(
                          ".studio-composer textarea",
                        )
                        ?.focus();
                    },
                    onRecoverConfirmation: async () => {
                      await discussion.recover();
                    },
                    onRetryGeneration: async () => {
                      await discussion.retryGeneration();
                    },
                    onLoadEarlier: discussion.loadMore,
                  }}
                >
                  <StudioComposer
                    discussion
                    {...composer}
                    key={composerEntry.context.key}
                    draft={composerEntry.draft}
                    updateDraft={composerSession.updateDraft}
                    prompt={composerEntry.draft.prompt}
                    setPrompt={(prompt) =>
                      composerSession.updateDraft((current) => ({
                        ...current,
                        prompt,
                      }))
                    }
                    initialInput={inputContext?.operationRequest}
                    pinnedSources={inputContext?.input.snapshot?.sources}
                    pinnedDesign={inputContext?.input.snapshot?.designStyle}
                    artifactContext={artifactContext}
                    locked={false}
                    outputLocked={false}
                    intentControl={
                      <div className="visual-intent">
                        <button
                          type="button"
                          aria-pressed={
                            editingCurrent &&
                            inputContext.target.id === selectedRevision?.id
                          }
                          disabled={
                            !selectedRevision ||
                            !["ready", "confirmed", "rejected"].includes(
                              selectedRevision.status,
                            )
                          }
                          onClick={() =>
                            void run(async () => {
                              if (!selectedRevision) return;
                              return composerSession.selectSource(async () => {
                                const input = await api.getRevisionInput(
                                  projectId,
                                  selectedRevision.id,
                                );
                                return [
                                  {
                                    kind: "input",
                                    key: `revision:${selectedRevision.id}`,
                                    title: `修改版本 ${selectedRevision.version}`,
                                    target: {
                                      kind: "revision",
                                      id: selectedRevision.id,
                                      etag: etag(selectedRevision),
                                      feedbackIds,
                                    },
                                    input: {
                                      plan: input.plan,
                                      request: input.request,
                                      snapshot: input.snapshot,
                                      sha256: input.sha256,
                                    },
                                    operationRequest: input.modificationRequest,
                                    version: selectedRevision.version,
                                  },
                                  "",
                                  {
                                    inheritPrompt: true,
                                    fromKey: composerEntry.context.key,
                                  },
                                ];
                              });
                            }, "已载入该版本的固定输入，可调整资料和设计")
                          }
                        >
                          修改版本
                          {selectedRevision
                            ? ` ${selectedRevision.version}`
                            : ""}
                        </button>
                        <button
                          type="button"
                          aria-pressed={composerEntry.context.kind === "new"}
                          onClick={() => {
                            composerSession.switchTo(
                              composerSession.newContext,
                            );
                            setInteraction(undefined);
                          }}
                        >
                          新建计划
                        </button>
                        <span>
                          {editingCurrent
                            ? `源版本 ${inputContext.version} · ${selectedRevision?.id === inputContext.target.id ? interaction?.label || "版本整体" : "仍绑定原来源，浏览不会更改提交目标"}`
                            : artifactContext
                              ? `${artifactPromptLabel(artifactContext)}：${artifactContext.title}`
                              : "使用下方模型、资料和设计"}
                        </span>
                      </div>
                    }
                    busy={discussion.pending}
                    disabled={
                      composer.disabled ||
                      !canEdit ||
                      !composerSession.ready ||
                      composerSession.sourcePending
                    }
                    uploads={discussion.uploads}
                    onRetryUpload={discussion.retryUpload}
                    onCancelUpload={discussion.cancelUpload}
                    onSubmit={submitPlan}
                  />
                  {composerSession.sourcePending && (
                    <p className="visual-muted" role="status">
                      正在读取所选版本与批注…
                    </p>
                  )}
                </RequirementInput>
              )}
            </div>
          </footer>
        }
      />
    </div>
  );
}
const buttonClass = "visual-button";
type Operation = (
  operation: () => Promise<unknown>,
  success: string,
) => Promise<void>;
function etag(value: { revision: number }): string {
  return `"${value.revision}"`;
}
function planStatusLabel(status: string): string {
  return status === "ready" ? "生成完成" : statusLabel(status);
}
function statusLabel(status: string): string {
  return (
    (
      {
        approved: "已审批",
        queued: "排队中",
        generating: "生成中",
        building: "构建中",
        ready: "待确认",
        confirmed: "已确认",
        rejected: "已驳回",
        failed: "失败",
        cancelling: "正在取消",
        cancelled: "已取消",
        active: "有效",
        revoked: "已撤销",
        expired: "已过期",
        succeeded: "已完成",
        open: "未解决",
        resolved: "已解决",
      } as Record<string, string>
    )[status] ?? status
  );
}

function FeedbackRow({
  item,
  canEdit,
  run,
  location,
  onLocate,
}: {
  item: PrototypeFeedback;
  canEdit: boolean;
  run: Operation;
  location?: PrototypeFeedbackLocation;
  onLocate: (location: PrototypeFeedbackLocation) => void;
}) {
  const resolve = useResolveWorkbenchPrototypeV2Feedback(
    item.projectId,
    item.id,
  );
  return (
    <div className="mt-2 rounded border border-slate-200 p-2 text-xs">
      <p className="whitespace-pre-wrap">{item.body}</p>
      {item.anchor && (
        <p className="mt-1 visual-muted">
          {item.anchor.pageId} ·{" "}
          {item.anchor.quote ||
            (item.anchor.scope === "node" ? item.anchor.nodeId : "页面")}
        </p>
      )}
      {location?.status === "missing" && (
        <p role="status">原元素未找到，原页面、引文与正文已保留。</p>
      )}
      {location?.status === "resolved" && (
        <button type="button" onClick={() => onLocate(location)}>
          在当前版本定位
        </button>
      )}
      <p className="mt-1 visual-muted">{statusLabel(item.status)}</p>
      {item.status === "open" && (
        <button
          type="button"
          disabled={!canEdit || resolve.isPending}
          onClick={() =>
            void run(
              () => resolve.mutateAsync({ ifMatch: etag(item), request: {} }),
              "批注已解决",
            )
          }
          className={`${buttonClass} mt-1`}
        >
          解决
        </button>
      )}
    </div>
  );
}
function ShareRow({
  item,
  projectId,
  canEdit,
  run,
}: {
  item: PrototypeShare;
  projectId: string;
  canEdit: boolean;
  run: Operation;
}) {
  const revoke = useRevokeWorkbenchPrototypeV2Share(projectId, item.id);
  const [copyError, setCopyError] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span>
        {statusLabel(item.status)} ·{" "}
        {item.expiresAt
          ? new Date(item.expiresAt).toLocaleDateString()
          : "永久有效"}
      </span>
      {copyError && (
        <input
          aria-label="手动复制分享链接"
          readOnly
          value={item.url}
          onFocus={(e) => e.target.select()}
        />
      )}{" "}
      {item.status === "active" && (
        <>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 underline"
          >
            打开分享链接
          </a>
          <button
            type="button"
            onClick={() =>
              void run(async () => {
                try {
                  await navigator.clipboard.writeText(item.url);
                  setCopyError(false);
                } catch {
                  setCopyError(true);
                  throw new Error("请从文本框手动复制链接");
                }
              }, "链接已复制")
            }
          >
            复制链接
          </button>
          <button
            type="button"
            disabled={!canEdit || revoke.isPending}
            onClick={() =>
              void run(
                () => revoke.mutateAsync({ ifMatch: etag(item), request: {} }),
                "分享已撤销",
              )
            }
            className={buttonClass}
          >
            撤销
          </button>
        </>
      )}
    </div>
  );
}
function ExportRow({
  item,
  projectId,
  canEdit,
  run,
}: {
  item: PrototypeExport;
  projectId: string;
  canEdit: boolean;
  run: Operation;
}) {
  const retry = useRetryWorkbenchPrototypeV2Export(projectId, item.id);
  const cancel = useCancelWorkbenchPrototypeV2Export(projectId, item.id);
  const download = useDownloadWorkbenchPrototypeV2Export(projectId, item.id);
  return (
    <div data-studio-export-id={item.id} className="mt-2 rounded border border-slate-200 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {item.format.toUpperCase()} · {item.status === "cancelled" && !item.finishedAt ? "等待取消完成回执" : statusLabel(item.status)}
        </span>
        {item.status === "succeeded" && (
          <button
            type="button"
            disabled={download.isPending}
            onClick={() =>
              void run(async () => {
                if (!item.artifact) throw new Error("导出文件尚不可用");
                const blob = await verifyDownload(
                  await download.mutateAsync(),
                  {
                    sha256: item.artifact.artifactSha256,
                    size: item.artifact.byteSize,
                  },
                );
                saveBlob(
                  blob,
                  `prototype-${item.id}.${item.format === "html" ? "html" : "zip"}`,
                );
              }, "已向浏览器发起文件下载")
            }
            className={buttonClass}
          >
            下载
          </button>
        )}
        {["queued", "building"].includes(item.status) && (
          <button
            type="button"
            disabled={!canEdit || cancel.isPending}
            onClick={() =>
              void run(
                () => cancel.mutateAsync({ ifMatch: etag(item), request: {} }),
                "取消请求已提交，等待任务确认",
              )
            }
            className={buttonClass}
          >
            取消导出
          </button>
        )}
        {item.status === "failed" && (
          <button
            type="button"
            disabled={!canEdit || retry.isPending}
            onClick={() =>
              void run(
                () => retry.mutateAsync({ ifMatch: etag(item), request: {} }),
                "导出已重试",
              )
            }
            className={buttonClass}
          >
            重试
          </button>
        )}
      </div>
      {item.failure && (
        <p className="mt-1 text-red-700">{item.failure.detail}</p>
      )}
    </div>
  );
}
