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
  useWorkbenchPrototypeV2Feedback,
  useWorkbenchPrototypeV2Shares,
  useWorkbenchPrototypeV2Exports,
  useReviseWorkbenchPrototypeV2Revision,
  useRetryWorkbenchPrototypeV2Plan,
  useWorkbenchPrototypeProgress,
} from "@/lib/workbench/features/prototype-v2";
import type {
  PrototypeExport,
  PrototypeFeedback,
  PrototypePlan,
  PrototypeShare,
} from "@workbench/workbench-contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { createIdempotencyKey } from "@/lib/workbench/transport/contracts";
import { type PrototypePreviewInteraction } from "./preview";
import { useStudioRun, projectedRun, isActiveRun } from "@/lib/studio/run";
import { PageStage } from "./page-stage";
import { StudioComposer, type StudioComposerProps } from "./composer";
import type {
  StudioSubmission,
  StudioView,
  StudioArtifactContext,
} from "@/lib/studio/types";
import type { ProjectBootstrap } from "@workbench/workbench-contracts";
import { verifyDownload, saveBlob } from "./actions";
import { Main } from "./onlook/main";
import { DesignPanel } from "./onlook/design-panel";
import { ProjectViews, RunDetails } from "./project-views";
import Link from "next/link";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import { useQueryClient } from "@tanstack/react-query";
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
  composer: StudioComposerProps;
  onCreatePlan: PrototypePlanSubmit;
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
  bootstrap,
}: StudioWorkspaceProps) {
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
  const [artifactContext, setArtifactContext] =
    useState<StudioArtifactContext>();
  const [feedback, setFeedback] = useState("");
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
  const [composerIntent, setComposerIntent] = useState<"revise" | "new">(
    "revise",
  );
  const pendingComposerRevision = useRef<{
    signature: string;
    feedbackKey: string;
    reviseKey: string;
    feedbackId?: string;
  } | null>(null);
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
  const feedbackQuery = useWorkbenchPrototypeV2Feedback(
    projectId,
    selectedRevision?.id ?? "",
  );
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
  const editingCurrent =
    composerIntent === "revise" &&
    Boolean(
      selectedRevision &&
        ["ready", "confirmed", "rejected"].includes(selectedRevision.status),
    );
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
    setComposerIntent("revise");
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
    setSubmitting(true);
    setError(undefined);
    try {
      if (editingCurrent && selectedRevision) {
        if (submission.files?.length || submission.sourceIds?.length || false)
          throw new Error(
            "修改当前版本沿用原有资料和设计上下文。请移除新附件，或选择“新建计划”使用这些输入。",
          );
        const pageId = interaction?.pageId || selectedPage?.id;
        const anchor = pageId
          ? {
              pageId,
              selector:
                interaction?.target ?? `main[data-wb-screen="${pageId}"]`,
              quote: interaction?.label ?? selectedPage?.title ?? "",
            }
          : null;
        const signature = JSON.stringify({
          revisionId: selectedRevision.id,
          prompt: submission.prompt.trim(),
          anchor,
        });
        if (pendingComposerRevision.current?.signature !== signature)
          pendingComposerRevision.current = {
            signature,
            feedbackKey: createIdempotencyKey("prototype-feedback"),
            reviseKey: createIdempotencyKey("prototype-revise"),
          };
        const command = pendingComposerRevision.current;
        if (!command.feedbackId) {
          const saved = await createFeedback.mutateAsync({
            idempotencyKey: command.feedbackKey,
            request: { body: submission.prompt.trim(), anchor },
          });
          command.feedbackId = saved.value.id;
        }
        const next = await reviseRevision.mutateAsync({
          ifMatch: etag(selectedRevision),
          idempotencyKey: command.reviseKey,
          request: {
            feedbackIds: [command.feedbackId],
            prompt: submission.prompt.trim(),
          },
        });
        pendingComposerRevision.current = null;
        awaitingPlan.current = next.value.id;
        setSelection((current) => ({ ...current, planId: next.value.id }));
        setMessage(
          `正在基于版本 ${selectedRevision.version} 生成新版本，原版本保持不变`,
        );
        return next.value.id;
      }
      if (!(submission.requestedArtifactKinds ?? []).includes("prototype")) {
        const accepted = await composer.onSubmit(submission);
        if (accepted) {
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
      selectPlan(created);
      setFollowRun(true);
      setPanel("plan");
      setMessage("计划已创建，请审阅后审批生成");
      return created.id;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交原型请求失败");
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
          ? { pageId, selector: interaction.target, quote: interaction.label }
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
    setComposerIntent("new");
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
              {progress.snapshot && (
                <dl className="visual-input-summary">
                  <dt>输出</dt>
                  <dd>
                    {progress.snapshot.input.requestedArtifactKinds
                      .map((kind) =>
                        kind === "prd"
                          ? "需求文档"
                          : kind === "prototype"
                            ? "原型"
                            : kind,
                      )
                      .join(" + ") || "沿用源计划"}
                  </dd>
                  <dt>模型</dt>
                  <dd>{progress.snapshot.input.modelId ?? "沿用源计划"}</dd>
                  <dt>终端</dt>
                  <dd>
                    {progress.snapshot.input.targetSurface ?? "沿用源计划"}
                  </dd>
                  <dt>资料</dt>
                  <dd>{progress.snapshot.input.sourceIds.length} 个导入源</dd>
                  <dt>设计</dt>
                  <dd>{progress.snapshot.input.designStyle ?? "沿用源计划"}</dd>
                </dl>
              )}
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
                <button
                  type="button"
                  onClick={() => {
                    composer.setPrompt(plan.prompt);
                    setComposerIntent("new");
                    setPanel(null);
                  }}
                >
                  保留文字新建计划
                </button>
              </div>
              <p className="visual-muted">
                已提交计划不能原地编辑。新建时请核对资料与设计上下文。
              </p>
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
                绑定版本 {selectedRevision.version} ·{" "}
                {interaction?.label || "普通批注"}
              </p>
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
              {visibleFeedback.length === 0 && (
                <p className="visual-muted">暂无批注</p>
              )}
              {visibleFeedback.map((item) => (
                <div key={item.id} className="visual-feedback">
                  <label>
                    <input
                      type="checkbox"
                      disabled={!canEdit || item.status !== "open"}
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
                  <FeedbackRow item={item} canEdit={canEdit} run={run} />
                  {item.anchor &&
                    !pages.some((p) => p.id === item.anchor?.pageId) && (
                      <p>原页面/元素未找到，正文已保留</p>
                    )}
                </div>
              ))}
              <button
                type="button"
                disabled={
                  !canEdit ||
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
                  composer.setPrompt(text);
                  setComposerIntent("new");
                  setArtifactContext(context);
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
              <StudioComposer
                {...composer}
                artifactContext={editingCurrent ? undefined : artifactContext}
                locked={editingCurrent}
                intentControl={
                  <div className="visual-intent">
                    <button
                      type="button"
                      aria-pressed={editingCurrent}
                      disabled={
                        !selectedRevision ||
                        !["ready", "confirmed", "rejected"].includes(
                          selectedRevision.status,
                        )
                      }
                      onClick={() => setComposerIntent("revise")}
                    >
                      修改版本
                      {selectedRevision ? ` ${selectedRevision.version}` : ""}
                    </button>
                    <button
                      type="button"
                      aria-pressed={!editingCurrent}
                      onClick={() => {
                        setComposerIntent("new");
                        setInteraction(undefined);
                        setArtifactContext(undefined);
                      }}
                    >
                      新建计划
                    </button>
                    <span>
                      {editingCurrent
                        ? `沿用原资料 · ${interaction?.label || selectedPage?.title || "版本整体"}`
                        : "使用下方模型、资料和设计"}
                    </span>
                  </div>
                }
                busy={composer.busy || submitting || running || directRunning}
                disabled={composer.disabled || !canEdit}
                onSubmit={submitPlan}
              />
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
}: {
  item: PrototypeFeedback;
  canEdit: boolean;
  run: Operation;
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
          {item.anchor.pageId} · {item.anchor.quote || item.anchor.selector}
        </p>
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
