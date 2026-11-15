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
  usePrototypeV2PlanAction,
  useWorkbenchPrototypeV2Plan,
  useWorkbenchPrototypeV2Plans,
  useWorkbenchPrototypeV2Revision,
  useWorkbenchPrototypeV2Revisions,
  useWorkbenchPrototypeV2RevisionDiff,
  useWorkbenchPrototypeV2Shares,
  useWorkbenchPrototypeV2Exports,
  useReviseWorkbenchPrototypeV2Revision,
  useRetryWorkbenchPrototypeV2Plan,
  useWorkbenchPrototypeProgress,
} from "@/lib/workbench/features/prototype-v2";
import type {
  PrototypeExport,
  PrototypeFeedback,
  PrototypeFeedbackLocation,
  PrototypePlan,
  PrototypeShare,
} from "@workbench/workbench-contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { createIdempotencyKey } from "@/lib/workbench/transport/contracts";
import { type PrototypePreviewInteraction } from "./preview";
import { useStudioRun, projectedRun, isActiveRun } from "@/lib/studio/run";
import { useWorkbenchPrototypeV2Api } from "@/lib/studio/api";
import { useStudioComposerSession } from "@/lib/studio/composer-session";
import { PlanInputSummary } from "./plan-input";
import { PageStage } from "./page-stage";
import { StudioComposer, type StudioComposerProps } from "./composer";
import type {
  StudioSubmission,
  StudioPlanTarget,
  StudioView,
} from "@/lib/studio/types";
import type { ProjectBootstrap } from "@workbench/workbench-contracts";
import { verifyDownload, saveBlob } from "./actions";
import { Main } from "./onlook/main";
import { DesignPanel } from "./onlook/design-panel";
import { ProjectViews, RunDetails } from "./project-views";
import Link from "next/link";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

export type PrototypePlanSubmit = (
  submission: StudioSubmission,
) => Promise<PrototypePlan | null>;

type StudioWorkspaceProps = {
  projectId: string;
  canEdit: boolean;
  composer: Omit<
    StudioComposerProps,
    "prompt" | "setPrompt" | "draft" | "updateDraft"
  >;
  onCreatePlan: PrototypePlanSubmit;
  onSaveInput: (
    input: StudioSubmission,
    target: StudioPlanTarget,
  ) => Promise<PrototypePlan | null>;
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
  window.history.replaceState(window.history.state, "", url);
}

export function StudioWorkspace({
  projectId,
  canEdit,
  composer,
  onCreatePlan,
  onSaveInput,
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
  const conflictingInput = composerEntry.conflict;
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
    window.history.pushState(window.history.state, "", url);
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
  const [panel, setPanel] = useState<
    "plan" | "versions" | "feedback" | "delivery" | null
  >(null);
  const [focused, setFocused] = useState(false);
  const [feedbackIds, setFeedbackIds] = useState<string[]>([]);
  const [feedbackFilter, setFeedbackFilter] = useState("all");
  const [expiry, setExpiry] = useState("7");
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

  const pendingFeedback = useRef<{ signature: string; key: string } | null>(
    null,
  );
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const [interaction, setInteraction] = useState<PrototypePreviewInteraction>();

  const awaitingPlan = useRef<string | undefined>(undefined);
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
  const locationsQuery = useQuery({
    queryKey: [
      ...workbenchQueryKeys.prototypeV2(projectId),
      "feedback-locations",
      selectedRevisionId,
      feedbackRevisionId,
    ],
    queryFn: () =>
      api.feedbackLocations(projectId, selectedRevisionId, feedbackRevisionId),
    enabled: Boolean(
      selectedRevisionId && feedbackRevisionId && panel === "feedback",
    ),
    refetchInterval: panel === "feedback" ? 3000 : false,
  });
  const feedbackQuery = {
    data: locationsQuery.data?.items.map((item) => item.feedback),
    error: locationsQuery.error,
  };
  const sharesQuery = useWorkbenchPrototypeV2Shares(projectId);
  const exportsQuery = useWorkbenchPrototypeV2Exports(projectId);
  const createPreviewToken = useCreateWorkbenchPrototypeV2PreviewToken(
    projectId,
    selectedRevision?.id ?? "",
  );
  const approvePlan = usePrototypeV2PlanAction(projectId, planId, "approve");
  const cancelPlan = usePrototypeV2PlanAction(projectId, planId, "cancel");
  const retryPlan = useRetryWorkbenchPrototypeV2Plan(projectId, planId);
  const createFeedback = useCreateWorkbenchPrototypeV2Feedback(
    projectId,
    selectedRevision?.id ?? "",
  );
  const reviseRevision = useReviseWorkbenchPrototypeV2Revision(
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
  const openFeedback =
    feedbackQuery.data?.filter((item) => item.status === "open") ?? [];
  const previousRevision = revisions.find(
    (revision) => revision.id === selectedRevision?.sourceRevisionId,
  );
  const diffQuery = useWorkbenchPrototypeV2RevisionDiff(
    projectId,
    selectedRevision?.id ?? "",
  );

  const previews = Object.values(progress.projection?.generationPreviews ?? {});
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
    if (plan?.status === "draft") setPanel("plan");
  }, [plan?.id, plan?.status]);

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
      !awaitingPlan.current
    )
      setSelection((current) => ({
        ...current,
        planId: selectedRevisionPlan.id,
      }));
  }, [
    directRevisionQuery.data,
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
      awaitingPlan.current === plan?.id && plan?.status === "ready"
        ? revisions.find((revision) => revision.version === plan.contentVersion)
        : undefined;
    if (generated) {
      awaitingPlan.current = undefined;
      setSelection((current) => ({
        ...current,
        revisionId: generated.id,
        pageId: current.pageId,
      }));
    } else if (!selectedRevisionId) {
      const latest = revisions[revisions.length - 1]!;
      setSelection((current) => ({
        ...current,
        revisionId: latest.id,
        pageId: "",
      }));
    }
  }, [plan, revisions, selectedRevisionId]);
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
      !(running && followRun) &&
      !pages.some((page) => page.id === selectedPageId)
    )
      setSelection((current) => ({ ...current, pageId: pages[0]?.id ?? "" }));
  }, [pages, selectedPageId, selectedRevision, running, followRun]);
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
      await operation();
      setMessage(success);
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
  const submitPlan: StudioComposerProps["onSubmit"] = async (submission) => {
    submission = {
      ...submission,
      onFileSource: (file, sourceId) =>
        composerSession.bindFileSource(
          composerEntry.context.key,
          file,
          sourceId,
        ),
    };
    setSubmitting(true);
    setError(undefined);
    try {
      if (inputContext) {
        const target = { ...inputContext.target };
        if (
          target.kind === "revision" &&
          target.id === selectedRevision?.id &&
          interaction?.revisionId === target.id
        ) {
          const signature = JSON.stringify({
            revisionId: target.id,
            prompt: submission.prompt,
            interaction,
          });
          if (pendingFeedback.current?.signature !== signature)
            pendingFeedback.current = {
              signature,
              key: createIdempotencyKey("prototype-feedback"),
            };
          const saved = await createFeedback.mutateAsync({
            idempotencyKey: pendingFeedback.current.key,
            request: {
              body: submission.prompt,
              anchor: {
                sourceRevisionId: interaction.revisionId,
                scope: "node",
                pageId: interaction.pageId,
                nodeId: interaction.nodeId,
                quote: interaction.label,
              },
            },
          });
          target.feedbackIds = [
            ...new Set([...(target.feedbackIds ?? []), saved.value.id]),
          ];
        }
        const saved = await onSaveInput(submission, target);
        if (!saved) return null;
        composerSession.complete(
          composerEntry.context.key,
          composerEntry.draft,
        );
        selectPlan(saved);
        setPanel("plan");
        setMessage(
          target.kind === "draft"
            ? "完整输入已保存，请重新审阅后开始生成"
            : "修改计划已创建，保留源版本关系；请审阅后开始生成",
        );
        return saved.id;
      }
      if (!(submission.requestedArtifactKinds ?? []).includes("prototype")) {
        const accepted = await composer.onSubmit(submission);
        if (accepted) {
          composerSession.complete(
            composerEntry.context.key,
            composerEntry.draft,
          );
          setDirectRunId(accepted);
          const url = new URL(window.location.href);
          url.searchParams.set("run", accepted);
          window.history.replaceState(window.history.state, "", url);
          setView("documents");
        }
        return accepted;
      }
      const created = await onCreatePlan(submission);
      if (!created) return null;
      composerSession.complete(composerEntry.context.key, composerEntry.draft);
      selectPlan(created);
      setFollowRun(true);
      setPanel("plan");
      setMessage("计划已创建，请审阅后审批生成");
      return created.id;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交原型请求失败");
      if (
        isWorkbenchApiError(cause) &&
        [409, 412].includes(cause.status) &&
        inputContext?.target.kind === "draft"
      ) {
        await queryClient.invalidateQueries({
          queryKey: workbenchQueryKeys.prototypeV2(projectId),
        });
        await queryClient.invalidateQueries({
          queryKey: ["studio", "plan-input", projectId],
        });
        try {
          composerSession.setConflict(
            composerEntry.context.key,
            await api.getPlanInput(projectId, inputContext.target.id),
          );
        } catch {
          /* Keep the local draft; normal plan input loading exposes recovery. */
        }
      }
      return null;
    } finally {
      setSubmitting(false);
    }
  };
  const addFeedback = () =>
    run(async () => {
      const pageId = interaction?.pageId || selectedPage?.id;
      const signature = JSON.stringify({
        revisionId: selectedRevision?.id,
        feedback,
        interaction,
      });
      if (pendingFeedback.current?.signature !== signature)
        pendingFeedback.current = {
          signature,
          key: createIdempotencyKey("prototype-feedback"),
        };
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
      await createFeedback.mutateAsync({
        idempotencyKey: pendingFeedback.current.key,
        request: { body: feedback.trim(), anchor },
      });
      setFeedback((current) => (current === feedback ? "" : current));
      pendingFeedback.current = null;
    }, "批注已保存到当前版本");

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
  const selectedFeedback = openFeedback.filter((item) =>
    feedbackIds.includes(item.id),
  );
  const visibleFeedback = (feedbackQuery.data ?? []).filter(
    (item) =>
      feedbackFilter === "all" ||
      item.status === feedbackFilter ||
      (feedbackFilter === "page" && item.anchor?.pageId === selectedPage?.id),
  );
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
              <PlanInputSummary
                projectId={projectId}
                plan={plan}
                canEdit={canEdit && !running}
                onAdjust={(input) => {
                  composerSession.switchTo(
                    {
                      kind: "input",
                      key: `draft:${plan.id}`,
                      title: `调整计划：${plan.title}`,
                      target: {
                        kind: "draft",
                        id: plan.id,
                        etag: etag(input.plan),
                      },
                      input,
                    },
                    input.plan.prompt,
                  );
                  setPanel(null);
                }}
              />
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
                {plan.status === "draft" && (
                  <button
                    type="button"
                    disabled={!canEdit || approvePlan.isPending}
                    onClick={() =>
                      void run(async () => {
                        awaitingPlan.current = plan.id;
                        setFollowRun(true);
                        await approvePlan.mutateAsync({
                          ifMatch: etag(plan),
                          request: {},
                        });
                        progress.reconnect();
                      }, "已提交生成，等待执行")
                    }
                    className="visual-primary"
                  >
                    审批并开始生成
                  </button>
                )}
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
              从下方输入需求。计划创建后，在这里核对输入并审批。
            </p>
          )}
        </>
      )}
      {panel === "versions" && (
        <>
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
                  value={feedbackFilter}
                  onChange={(e) => setFeedbackFilter(e.target.value)}
                >
                  <option value="all">全部</option>
                  <option value="page">当前页面</option>
                  <option value="open">未解决</option>
                  <option value="resolved">已解决</option>
                </select>
              </label>
              {locationsQuery.data?.items.length === 100 && (
                <p className="visual-muted">
                  显示此来源版本的前 100 条批注，其他批注尚未载入。
                </p>
              )}
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
                    location={locationsQuery.data?.items.find(
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
              <button
                type="button"
                disabled={
                  !canEdit ||
                  feedbackRevisionId !== selectedRevision.id ||
                  !selectedFeedback.length ||
                  selectedFeedback.length > 100 ||
                  running ||
                  reviseRevision.isPending
                }
                onClick={() =>
                  void run(async () => {
                    const next = await reviseRevision.mutateAsync({
                      ifMatch: etag(selectedRevision),
                      request: {
                        feedbackIds: selectedFeedback.map((item) => item.id),
                      },
                    });
                    awaitingPlan.current = next.value.id;
                    setFollowRun(true);
                    setSelection((current) => ({
                      ...current,
                      planId: next.value.id,
                    }));
                  }, "已根据所选批注开始生成新版本")
                }
              >
                使用所选 {selectedFeedback.length} 条批注生成新版本
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
                  onChange={(e) => setExpiry(e.target.value)}
                >
                  <option value="7">7 天</option>
                  <option value="30">30 天</option>
                  <option value="0">长期有效</option>
                </select>
              </label>
              <button
                type="button"
                disabled={!canEdit || !ready || createShare.isPending}
                onClick={() =>
                  void run(
                    () =>
                      createShare.mutateAsync({
                        request: {
                          revisionId: selectedRevision.id,
                          expiresAt:
                            expiry === "0"
                              ? null
                              : new Date(
                                  Date.now() + Number(expiry) * 86400000,
                                ).toISOString(),
                        },
                      }),
                    "分享链接已创建",
                  )
                }
              >
                创建分享
              </button>
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
            <Link href="/" className="studio-wordmark" aria-label="项目首页">
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
                onClick={() => {
                  setView("pages");
                  setPanel("versions");
                }}
              >
                版本
              </button>
              <button onClick={() => setPanel("delivery")}>分享 / 导出</button>
            </div>
          </>
        }
        leftPanel={
          <DesignPanel
            tabs={navigation}
            selectedTab={panel ?? view}
            onSelect={(value) => {
              if (
                ["plan", "versions", "feedback", "delivery"].includes(
                  value ?? "",
                )
              )
                setPanel(value as typeof panel);
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
                      window.history.replaceState(
                        window.history.state,
                        "",
                        url,
                      );
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
                onPage={(id) => {
                  const next = { ...selection, pageId: id };
                  const url = new URL(window.location.href);
                  url.searchParams.set("page", id);
                  window.history.pushState(window.history.state, "", url);
                  setSelection(next);
                }}
                onSelection={(next) => {
                  setInteraction(next);
                  if (next) setPanel("feedback");
                }}
                previews={previews}
                showDraft={
                  followRun &&
                  previews.length > 0 &&
                  (running || !selectedRevision?.previewHtml)
                }
                running={running}
              />
            ) : (
              <ProjectViews
                activeRunId={directRunId}
                previews={
                  directRunning
                    ? Object.values(direct.projection?.generationPreviews ?? {})
                    : []
                }
                view={view}
                bootstrap={bootstrap}
                canEdit={canEdit}
                onPrompt={(text, context) => {
                  composerSession.switchTo(
                    context
                      ? {
                          kind: "artifact",
                          key: `artifact:${JSON.stringify(context.artifactTargets)}`,
                          title: `完善：${context.title}`,
                          artifact: context,
                        }
                      : composerSession.newContext,
                    text,
                  );
                  setFocused(false);
                }}
              />
            )}
          </>
        }
        bottomBar={
          <footer className="visual-composer-dock" data-focused={focused}>
            {(running || progress.error || plan?.status === "draft") && (
              <div className="visual-progress" role="status">
                <span className={running ? "visual-pulse" : ""} />
                <span>
                  {progress.connection === "reconnecting"
                    ? "正在恢复连接，保留最后画面"
                    : progress.error
                      ? "进度连接暂不可用"
                      : plan?.status === "draft"
                        ? "计划等待审批"
                        : livePlanRun?.status === "waiting_input"
                          ? "需要补充输入"
                          : (progress.projection?.phaseLabel ?? "正在准备生成")}
                </span>
                {running && (
                  <time>
                    {Math.floor(elapsed / 60)}分{elapsed % 60}秒
                  </time>
                )}
                <button type="button" onClick={() => setPanel("plan")}>
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
            <div hidden={focused}>
              {inputContext?.target.kind === "revision" &&
                !inputContext.operationRequest && (
                  <p role="alert">
                    源版本操作输入需重新载入，请点击“修改版本”核对后继续；草稿仍保留。
                  </p>
                )}
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
              {conflictingInput && (
                <div className="studio-input-conflict" role="alert">
                  <p>
                    计划输入已被其他操作更新。你的全部调整仍保留，请先核对最新记录。
                  </p>
                  <details>
                    <summary>查看最新保存的输入</summary>
                    <p>{conflictingInput.plan.prompt}</p>
                    <p>
                      模型 {conflictingInput.request.modelId} · 资料{" "}
                      {conflictingInput.snapshot?.sources
                        .map((source) => source.label)
                        .join("、") || "无"}
                    </p>
                  </details>
                  <button
                    disabled={conflictingInput.plan.status !== "draft"}
                    onClick={() => {
                      composerSession.acceptConflict();
                      setError(undefined);
                    }}
                  >
                    保留我的调整并继续
                  </button>
                </div>
              )}
              {composerSession.ready && (
                <StudioComposer
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
                  initialInput={
                    inputContext?.operationRequest ??
                    inputContext?.input.request
                  }
                  pinnedSources={inputContext?.input.snapshot?.sources}
                  pinnedDesign={inputContext?.input.snapshot?.designStyle}
                  artifactContext={artifactContext}
                  locked={false}
                  outputLocked={Boolean(
                    inputContext?.target.kind === "revision" ||
                      inputContext?.input.plan.sourceRevisionId,
                  )}
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
                            const input = await api.getRevisionInput(
                              projectId,
                              selectedRevision.id,
                            );
                            composerSession.switchTo(
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
                            );
                          }, "已载入该版本的固定输入，可调整资料和设计")
                        }
                      >
                        修改版本
                        {selectedRevision ? ` ${selectedRevision.version}` : ""}
                      </button>
                      <button
                        type="button"
                        aria-pressed={composerEntry.context.kind === "new"}
                        onClick={() => {
                          composerSession.switchTo(composerSession.newContext);
                          setInteraction(undefined);
                        }}
                      >
                        新建计划
                      </button>
                      <span>
                        {editingCurrent
                          ? `源版本 ${inputContext.version} · ${selectedRevision?.id === inputContext.target.id ? interaction?.label || "版本整体" : "仍绑定原来源，浏览不会更改提交目标"}`
                          : inputContext?.target.kind === "draft"
                            ? `${inputContext.title} · 保存后需审批`
                            : artifactContext
                              ? `完善固定产物：${artifactContext.title}`
                              : "使用下方模型、资料和设计"}
                      </span>
                    </div>
                  }
                  busy={composer.busy || submitting || running || directRunning}
                  disabled={
                    (inputContext?.target.kind === "revision" &&
                      !inputContext.operationRequest) ||
                    composer.disabled ||
                    !canEdit ||
                    !!conflictingInput ||
                    !composerSession.ready
                  }
                  onSubmit={submitPlan}
                />
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
        draft: "待审批",
        approved: "已审批",
        queued: "排队中",
        generating: "生成中",
        building: "构建中",
        ready: "待确认",
        confirmed: "已确认",
        rejected: "已驳回",
        failed: "失败",
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
    <div className="mt-2 rounded border border-slate-200 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          {item.format.toUpperCase()} · {statusLabel(item.status)}
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
