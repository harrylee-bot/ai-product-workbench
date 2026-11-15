"use client";

import {
  useCreateWorkbenchPrototypeV2Export, useCreateWorkbenchPrototypeV2Feedback,
  useCreateWorkbenchPrototypeV2PreviewToken, useCreateWorkbenchPrototypeV2Share,
  useCancelWorkbenchPrototypeV2Export, useDownloadWorkbenchPrototypeV2Export,
  useResolveWorkbenchPrototypeV2Feedback, useRevokeWorkbenchPrototypeV2Share,
  useReviewWorkbenchPrototypeV2Revision, useRetryWorkbenchPrototypeV2Export,
  usePrototypeV2PlanAction, useWorkbenchPrototypeV2Plan, useWorkbenchPrototypeV2Plans,
  useWorkbenchPrototypeV2Revision, useWorkbenchPrototypeV2Revisions, useWorkbenchPrototypeV2RevisionDiff,
  useWorkbenchPrototypeV2Feedback, useWorkbenchPrototypeV2Shares, useWorkbenchPrototypeV2Exports,
  useReviseWorkbenchPrototypeV2Revision, useRetryWorkbenchPrototypeV2Plan,
  type WorkbenchRunSubmission,
} from "@/lib/workbench/features";
import type { PrototypeExport, PrototypeFeedback, PrototypePlan, PrototypeShare } from "@workbench/workbench-contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { createIdempotencyKey } from "@/lib/workbench/transport/contracts";
import { createPrototypeSandboxDocument, parsePrototypePreviewInteraction, parsePrototypePreviewPage, type PrototypePreviewInteraction } from "./prototype-v2-preview";
import { ProjectComposer, type WorkbenchProjectComposerProps } from "./workbench-project-composer";

export type PrototypePlanSubmit = (submission: WorkbenchRunSubmission) => Promise<PrototypePlan | null>;

type PrototypeV2PanelProps = {
  projectId: string;
  canEdit: boolean;
  composer: WorkbenchProjectComposerProps;
  onCreatePlan: PrototypePlanSubmit;
  onClose: () => void;
};

type Selection = { planId: string; revisionId: string; pageId: string };
export function readPrototypeSelection(search: string): Selection {
  const params = new URLSearchParams(search);
  return { planId: params.get("prototypePlan") ?? "", revisionId: params.get("prototypeRevision") ?? "", pageId: params.get("prototypePage") ?? "" };
}

export function writePrototypeSelection(selection: Selection): void {
  const url = new URL(window.location.href);
  url.searchParams.set("prototype", "1");
  for (const [key, value] of [["prototypePlan", selection.planId], ["prototypeRevision", selection.revisionId], ["prototypePage", selection.pageId]]) {
    if (value) url.searchParams.set(key!, value); else url.searchParams.delete(key!);
  }
  window.history.replaceState(window.history.state, "", url);
}

export function WorkbenchPrototypeV2Panel({ projectId, canEdit, composer, onCreatePlan, onClose }: PrototypeV2PanelProps) {
  const [selection, setSelection] = useState<Selection>(() => readPrototypeSelection(typeof window === "undefined" ? "" : window.location.search));
  const { planId, revisionId: selectedRevisionId, pageId: selectedPageId } = selection;
  const [feedback, setFeedback] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [composerIntent, setComposerIntent] = useState<"revise" | "new">("revise");
  const pendingComposerRevision = useRef<{ signature: string; feedbackKey: string; reviseKey: string; feedbackId?: string } | null>(null);
  const [interaction, setInteraction] = useState<PrototypePreviewInteraction>();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const awaitingPlan = useRef<string | undefined>(undefined);
  const plansQuery = useWorkbenchPrototypeV2Plans(projectId);
  const planQuery = useWorkbenchPrototypeV2Plan(projectId, planId);
  const directRevisionQuery = useWorkbenchPrototypeV2Revision(projectId, selectedRevisionId);
  const refetchRevision = directRevisionQuery.refetch;
  const plan = planQuery.data?.value;
  const rootPlanId = plan?.rootPlanId ?? plan?.id ?? directRevisionQuery.data?.value.planId ?? "";
  const revisionsQuery = useWorkbenchPrototypeV2Revisions(projectId, rootPlanId, Boolean(rootPlanId));
  const revisions = revisionsQuery.data ?? [];
  const selectedSummary = revisions.find((revision) => revision.id === selectedRevisionId);
  const selectedRevision = directRevisionQuery.data?.value;
  const selectedRevisionPlan = plansQuery.data?.find((candidate) =>
    (candidate.rootPlanId ?? candidate.id) === selectedRevision?.planId
    && candidate.contentVersion === selectedRevision.version);
  const pages = useMemo(() => selectedRevision ? [...selectedRevision.pages].sort((a, b) => a.order - b.order) : [], [selectedRevision]);
  const selectedPage = pages.find((page) => page.id === selectedPageId) ?? pages[0];
  const feedbackQuery = useWorkbenchPrototypeV2Feedback(projectId, selectedRevision?.id ?? "");
  const sharesQuery = useWorkbenchPrototypeV2Shares(projectId);
  const exportsQuery = useWorkbenchPrototypeV2Exports(projectId);
  const createPreviewToken = useCreateWorkbenchPrototypeV2PreviewToken(projectId, selectedRevision?.id ?? "");
  const approvePlan = usePrototypeV2PlanAction(projectId, planId, "approve");
  const cancelPlan = usePrototypeV2PlanAction(projectId, planId, "cancel");
  const retryPlan = useRetryWorkbenchPrototypeV2Plan(projectId, planId);
  const createFeedback = useCreateWorkbenchPrototypeV2Feedback(projectId, selectedRevision?.id ?? "");
  const reviseRevision = useReviseWorkbenchPrototypeV2Revision(projectId, selectedRevision?.id ?? "");
  const createShare = useCreateWorkbenchPrototypeV2Share(projectId);
  const createExport = useCreateWorkbenchPrototypeV2Export(projectId);
  const confirmRevision = useReviewWorkbenchPrototypeV2Revision(projectId, selectedRevision?.id ?? "", "confirm");
  const rejectRevision = useReviewWorkbenchPrototypeV2Revision(projectId, selectedRevision?.id ?? "", "reject");
  const ready = Boolean(selectedRevision && ["ready", "confirmed"].includes(selectedRevision.status));
  const editingCurrent = composerIntent === "revise" && Boolean(selectedRevision && ["ready", "confirmed", "rejected"].includes(selectedRevision.status));
  const running = Boolean(plan && ["approved", "generating"].includes(plan.status));
  const openFeedback = feedbackQuery.data?.filter((item) => item.status === "open") ?? [];
  const previousRevision = revisions.find((revision) => revision.id === selectedRevision?.sourceRevisionId);
  const diffQuery = useWorkbenchPrototypeV2RevisionDiff(projectId, selectedRevision?.id ?? "");
  const changes = diffQuery.data?.pages.filter((page) => page.change !== "unchanged") ?? [];
  const previewContent = selectedRevision?.previewHtml;
  const srcDoc = useMemo(() => previewContent ? createPrototypeSandboxDocument(previewContent) : undefined, [previewContent]);

  useEffect(() => {
    const restore = () => setSelection(readPrototypeSelection(window.location.search));
    window.addEventListener("popstate", restore);
    window.addEventListener("workbench:prototype-open", restore);
    return () => { window.removeEventListener("popstate", restore); window.removeEventListener("workbench:prototype-open", restore); };
  }, []);
  useEffect(() => {
    if (!planId && directRevisionQuery.data && plansQuery.data) setSelection((current) => ({ ...current, planId: selectedRevisionPlan?.id ?? directRevisionQuery.data.value.planId }));
    else if (!planId && !selectedRevisionId && plansQuery.data?.length) setSelection((current) => ({ ...current, planId: plansQuery.data[0]!.id }));
    // Revisions belong to the history root. A copied root/revision URL must show
    // the child plan that generated that content version, including after retry.
    else if (selectedRevisionPlan && selectedRevision && plan?.id === planId
      && planId === selectedRevision.planId && planId !== selectedRevisionPlan.id
      && !running && !awaitingPlan.current) setSelection((current) => ({ ...current, planId: selectedRevisionPlan.id }));
  }, [directRevisionQuery.data, plan?.id, planId, plansQuery.data, running, selectedRevision, selectedRevisionId, selectedRevisionPlan?.id]);
  useEffect(() => {
    if (!revisions.length) return;
    const generated = awaitingPlan.current === plan?.id && plan?.status === "ready"
      ? revisions.find((revision) => revision.version === plan.contentVersion) : undefined;
    if (generated) {
      awaitingPlan.current = undefined;
      setSelection((current) => ({ ...current, revisionId: generated.id, pageId: "" }));
    } else if (!selectedRevisionId) {
      const latest = revisions[revisions.length - 1]!;
      setSelection((current) => ({ ...current, revisionId: latest.id, pageId: "" }));
    }
  }, [plan, revisions, selectedRevisionId]);
  useEffect(() => {
    if (selectedSummary && selectedRevision && selectedSummary.revision !== selectedRevision.revision) void refetchRevision();
  }, [refetchRevision, selectedRevision?.revision, selectedSummary?.revision]);
  useEffect(() => {
    if (selectedRevision && !pages.some((page) => page.id === selectedPageId)) setSelection((current) => ({ ...current, pageId: pages[0]?.id ?? "" }));
  }, [pages, selectedPageId, selectedRevision]);
  useEffect(() => { if (planId || selectedRevisionId) writePrototypeSelection(selection); }, [planId, selectedRevisionId, selection]);
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || (event.origin !== "" && event.origin !== "null")) return;
      const next = parsePrototypePreviewInteraction(event.data);
      if (next) setInteraction(next);
      const pageId = parsePrototypePreviewPage(event.data);
      if (pageId && pages.some((page) => page.id === pageId)) setSelection((current) => current.pageId === pageId ? current : { ...current, pageId });
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [pages]);
  const selectIframePage = () => iframeRef.current?.contentWindow?.postMessage({ type: "workbench.prototype.select-page", pageId: selectedPageId }, "*");
  useEffect(() => { selectIframePage(); setInteraction(undefined); }, [selectedPageId, selectedRevisionId]);
  useEffect(() => { setPreviewUrl(undefined); setComposerIntent("revise"); }, [selectedRevisionId]);

  const queryError = planQuery.error || directRevisionQuery.error || plansQuery.error || revisionsQuery.error || feedbackQuery.error || sharesQuery.error || exportsQuery.error || diffQuery.error;
  const run = async (operation: () => Promise<unknown>, success: string) => {
    setError(undefined); setMessage(undefined);
    try { await operation(); setMessage(success); } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
  };
  const selectPlan = (next: PrototypePlan) => { setSelection({ planId: next.id, revisionId: "", pageId: "" }); };
  const submitPlan: WorkbenchProjectComposerProps["onSubmitPrompt"] = async (submission) => {
    setSubmitting(true); setError(undefined);
    try {
      if (editingCurrent && selectedRevision) {
        if (submission.files?.length || submission.sourceIds?.length || submission.designSystemProvision) throw new Error("修改当前版本沿用原有资料和设计上下文。请移除新附件，或选择“新建计划”使用这些输入。");
        const pageId = interaction?.pageId || selectedPage?.id;
        const anchor = pageId ? { pageId, sourceRevisionId: selectedRevision.id, scope: "page" as const, quote: interaction?.label ?? selectedPage?.title ?? "" } : null;
        const signature = JSON.stringify({ revisionId: selectedRevision.id, prompt: submission.prompt.trim(), anchor });
        if (pendingComposerRevision.current?.signature !== signature) pendingComposerRevision.current = { signature, feedbackKey: createIdempotencyKey("prototype-feedback"), reviseKey: createIdempotencyKey("prototype-revise") };
        const command = pendingComposerRevision.current;
        if (!command.feedbackId) {
          const saved = await createFeedback.mutateAsync({ idempotencyKey: command.feedbackKey, request: { body: submission.prompt.trim(), anchor } });
          command.feedbackId = saved.value.id;
        }
        const next = await reviseRevision.mutateAsync({ ifMatch: etag(selectedRevision), idempotencyKey: command.reviseKey, request: { feedbackIds: [command.feedbackId], prompt: submission.prompt.trim() } });
        pendingComposerRevision.current = null;
        awaitingPlan.current = next.value.id;
        setSelection((current) => ({ ...current, planId: next.value.id }));
        setMessage(`正在基于版本 ${selectedRevision.version} 生成新版本，原版本保持不变`);
        return next.value.id;
      }
      if (!(submission.requestedArtifactKinds ?? []).includes("prototype")) {
        const accepted = await composer.onSubmitPrompt(submission);
        if (accepted) onClose();
        return accepted;
      }
      const created = await onCreatePlan(submission);
      if (!created) return null;
      selectPlan(created); setMessage("计划已创建，请审阅后审批生成"); return created.id;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "提交原型请求失败"); return null; }
    finally { setSubmitting(false); }
  };
  const addFeedback = () => run(async () => {
    const pageId = interaction?.pageId || selectedPage?.id;
    const anchor = interaction && pageId ? { pageId, sourceRevisionId: selectedRevision!.id, scope: "page" as const, quote: interaction.label } : null;
    await createFeedback.mutateAsync({ request: { body: feedback.trim(), anchor } }); setFeedback("");
  }, "批注已保存到当前版本");

  return <section className="absolute inset-0 z-[80] flex flex-col bg-[#111214] text-[#e8eaed]" data-workbench-prototype-v2-panel>
    <header className="flex min-h-[58px] items-center justify-between border-b border-white/[0.08] bg-[#18191b] px-4">
      <div><h2 className="text-sm font-semibold">交互原型工作台 V2</h2><p className="mt-1 text-xs text-[#9aa0a6]">在底部输入需求，保留所选模型、资料和设计风格</p></div>
      <button type="button" onClick={onClose} className={buttonClass}>返回项目</button>
    </header>
    <button type="button" className="border-b border-white/[0.08] px-4 py-2 text-left text-xs lg:hidden" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)}>计划与版本 {sidebarOpen ? "收起" : "展开"}</button>
    <div className="grid min-h-0 flex-1 grid-cols-1 pb-[calc(var(--workbench-project-composer-height,170px)+32px)] lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className={`${sidebarOpen ? "block" : "hidden"} max-h-[30vh] overflow-y-auto border-r border-white/[0.08] bg-[#18191b] p-4 lg:block lg:max-h-none`}>
        <h3 className="text-xs font-semibold">计划与版本</h3>
        <select aria-label="选择原型计划" className="mt-2 w-full rounded bg-[#25262a] p-2 text-xs" value={planId} onChange={(event) => { const item = plansQuery.data?.find((candidate) => candidate.id === event.target.value); if (item) selectPlan(item); }}>
          <option value="">选择计划</option>{plansQuery.data?.map((item) => <option key={item.id} value={item.id}>{item.title} · {planStatusLabel(item.status)}</option>)}
        </select>
        {plan && <div className="mt-3 rounded-lg border border-white/[0.1] p-3">
          <strong className="text-sm">{plan.title}</strong><p className="mt-2 whitespace-pre-wrap text-xs text-[#aeb3bb]">{plan.prompt}</p>
          <p className="mt-2 text-xs" role="status">计划状态：{planStatusLabel(plan.status)}</p>
          {plan.failure && <p role="alert" className="mt-2 text-xs text-[#f2a7a7]">{plan.failure.detail}</p>}
          <div className="mt-3 flex gap-2">
            {plan.status === "draft" && <button type="button" disabled={!canEdit || approvePlan.isPending} onClick={() => void run(async () => { awaitingPlan.current = plan.id; await approvePlan.mutateAsync({ ifMatch: etag(plan), request: {} }); }, "已提交生成")} className={buttonClass}>审批生成</button>}
            {running && <button type="button" disabled={!canEdit || cancelPlan.isPending} onClick={() => void run(() => cancelPlan.mutateAsync({ ifMatch: etag(plan), request: {} }), "取消请求已提交，正在等待运行时确认")} className={buttonClass}>取消生成</button>}
            {["failed", "cancelled"].includes(plan.status) && <button type="button" disabled={!canEdit || retryPlan.isPending} onClick={() => void run(async () => { const next = await retryPlan.mutateAsync({ ifMatch: etag(plan), request: {} }); awaitingPlan.current = next.value.id; setSelection((current) => ({ ...current, planId: next.value.id })); }, "已使用原输入重试生成")} className={buttonClass}>重试生成</button>}
          </div>
        </div>}
        {revisions.map((revision) => <button key={revision.id} type="button" onClick={() => { awaitingPlan.current = undefined; const owner = plansQuery.data?.find((candidate) => (candidate.rootPlanId ?? candidate.id) === revision.planId && candidate.contentVersion === revision.version); setSelection({ planId: owner?.id ?? revision.planId, revisionId: revision.id, pageId: "" }); }} className={`mt-2 block w-full rounded border p-2 text-left text-xs ${revision.id === selectedRevision?.id ? "border-[#7c4dff] bg-[#2a2140]" : "border-white/[0.1]"}`}>版本 {revision.version} · {statusLabel(revision.status)}<span className="mt-1 block text-[#9aa0a6]">{revision.title}</span></button>)}
        {selectedRevision?.status === "ready" && <div className="mt-2 flex gap-2">
          <button type="button" disabled={!canEdit || confirmRevision.isPending} onClick={() => void run(() => confirmRevision.mutateAsync({ ifMatch: etag(selectedRevision), request: {} }), "版本已确认")} className={buttonClass}>确认版本</button>
          <button type="button" disabled={!canEdit || rejectRevision.isPending} onClick={() => void run(() => rejectRevision.mutateAsync({ ifMatch: etag(selectedRevision), request: {} }), "版本已驳回")} className={buttonClass}>驳回版本</button>
        </div>}
        {diffQuery.data?.sourceRevisionId && <div className="mt-4 text-xs"><h3 className="font-semibold">与{previousRevision ? `版本 ${previousRevision.version}` : "来源版本"}比较</h3>{changes.length ? changes.map((item) => <p className="mt-1 text-[#aeb3bb]" key={item.pageId}>{{ added: "新增页面", removed: "删除页面", changed: "修改页面", unchanged: "未变化" }[item.change]} · {pages.find((page) => page.id === item.pageId)?.title ?? item.pageId}</p>) : <p className="mt-1 text-[#aeb3bb]">页面内容未变化</p>}</div>}
        {selectedRevision && <div className="mt-4"><h3 className="text-xs font-semibold">当前版本批注</h3>{feedbackQuery.data?.length === 0 && <p className="mt-2 text-xs text-[#9aa0a6]">暂无批注</p>}{feedbackQuery.data?.map((item) => <FeedbackRow key={item.id} item={item} canEdit={canEdit} run={run} />)}
          <button type="button" disabled={!canEdit || !openFeedback.length || running || reviseRevision.isPending || !["ready", "confirmed", "rejected"].includes(selectedRevision.status)} onClick={() => void run(async () => { const next = await reviseRevision.mutateAsync({ ifMatch: etag(selectedRevision), request: { feedbackIds: openFeedback.map((item) => item.id) } }); awaitingPlan.current = next.value.id; setSelection((current) => ({ ...current, planId: next.value.id })); }, "已根据批注开始生成新版本")} className={`${buttonClass} mt-2`}>根据未解决批注生成新版本</button>
        </div>}
        {sharesQuery.data?.some((item) => item.revisionId === selectedRevision?.id) && <h3 className="mt-4 text-xs font-semibold">当前版本分享</h3>}
        {sharesQuery.data?.filter((item) => item.revisionId === selectedRevision?.id).map((item) => <ShareRow key={item.id} item={item} projectId={projectId} canEdit={canEdit} run={run} />)}
        {exportsQuery.data?.some((item) => item.revisionId === selectedRevision?.id) && <h3 className="mt-4 text-xs font-semibold">当前版本导出</h3>}
        {exportsQuery.data?.filter((item) => item.revisionId === selectedRevision?.id).map((item) => <ExportRow key={item.id} item={item} projectId={projectId} canEdit={canEdit} run={run} />)}
      </aside>
      <main className="flex min-h-0 flex-col bg-[#202124] p-3">
        {selectedRevision && <div className="mb-3 flex flex-wrap gap-2">
          {pages.map((page) => <button key={page.id} type="button" aria-pressed={page.id === selectedPage?.id} onClick={() => setSelection((current) => ({ ...current, pageId: page.id }))} className={`${buttonClass} ${page.id === selectedPage?.id ? "bg-[#7c4dff]" : ""}`}>{page.title}</button>)}
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" disabled={!canEdit || !ready || createShare.isPending} onClick={() => void run(() => createShare.mutateAsync({ request: { revisionId: selectedRevision.id, expiresAt: null } }), "分享链接已创建")} className={buttonClass}>分享</button>
            {(["html", "react"] as const).map((format) => <button key={format} type="button" disabled={!canEdit || !ready || createExport.isPending} onClick={() => void run(() => createExport.mutateAsync({ request: { revisionId: selectedRevision.id, format } }), `${format.toUpperCase()} 导出已排队`)} className={buttonClass}>导出 {format === "html" ? "HTML" : "React"}</button>)}
            <button type="button" disabled={!ready || createPreviewToken.isPending} onClick={() => void run(async () => { const result = await createPreviewToken.mutateAsync(); setPreviewUrl(result.url); }, "隔离预览链接已创建")} className={buttonClass}>安全预览链接</button>
          </div>
        </div>}
        {previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer" className="mb-2 text-xs text-[#b79cff] underline">打开隔离预览</a>}
        {message && <p role="status" className="mb-2 text-xs text-[#8ed1a7]">{message}</p>}
        {(error || queryError) && <p role="alert" className="mb-2 text-xs text-[#f2a7a7]">{error ?? queryError?.message}</p>}
        {selectedPage && srcDoc ? <>
          <div className="mb-2 text-xs text-[#aeb3bb]" role="status" data-prototype-interaction-status>{interaction ? `${interaction.event} · ${interaction.label || interaction.tag}` : "点击页面元素可定位批注；表单和状态切换可直接操作"}</div>
          <iframe key={selectedRevision?.id} ref={iframeRef} title={selectedRevision?.title ?? selectedPage.title} srcDoc={srcDoc} onLoad={selectIframePage} sandbox="allow-scripts allow-forms" className="min-h-[200px] flex-1 rounded-lg border border-white/[0.1] bg-white" />
          <div className="mt-2 flex gap-2"><textarea aria-label="当前版本批注" value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={!canEdit} placeholder={interaction ? `批注：${interaction.label || interaction.target}` : "为当前版本写下批注"} className="min-h-[54px] flex-1 rounded border border-white/[0.1] bg-[#18191b] p-2 text-xs" /><button type="button" disabled={!canEdit || !feedback.trim() || createFeedback.isPending} onClick={() => void addFeedback()} className={buttonClass}>保存批注</button>{interaction && <button type="button" onClick={() => setInteraction(undefined)} className={buttonClass}>取消定位</button>}</div>
        </> : <div className="grid flex-1 place-items-center text-sm text-[#9aa0a6]">{running ? "正在生成原型，完成后将显示预览" : "在底部输入需求，创建并审批原型计划"}</div>}
      </main>
    </div>
    <ProjectComposer {...composer} generationContextLocked={editingCurrent} intentControl={<div className="mb-2 text-xs">
      <div className="flex items-center gap-2"><button type="button" aria-pressed={editingCurrent} disabled={!selectedRevision || !["ready", "confirmed", "rejected"].includes(selectedRevision.status)} onClick={() => setComposerIntent("revise")} className={`${buttonClass} ${editingCurrent ? "bg-[#3a2d4b]" : ""}`}>修改当前版本{selectedRevision ? ` ${selectedRevision.version}` : ""}</button><button type="button" aria-pressed={!editingCurrent} onClick={() => setComposerIntent("new")} className={`${buttonClass} ${!editingCurrent ? "bg-[#3a2d4b]" : ""}`}>新建计划</button></div>
      <p className="mt-2 text-[#9aa0a6]">{editingCurrent ? `针对${interaction?.label || selectedPage?.title || "当前页面"}修改；沿用当前版本的模型、资料和设计上下文` : "创建独立计划，使用所选模型、资料和设计风格"}</p>
    </div>} busy={composer.busy || submitting || running} disabled={composer.disabled || !canEdit} onSubmitPrompt={submitPlan} />
  </section>;
}

const buttonClass = "rounded-md border border-white/[0.12] px-3 py-2 text-xs disabled:opacity-50 hover:enabled:bg-white/[0.08]";
type Operation = (operation: () => Promise<unknown>, success: string) => Promise<void>;
function etag(value: { revision: number }): string { return `"${value.revision}"`; }
function planStatusLabel(status: string): string { return status === "ready" ? "生成完成" : statusLabel(status); }
function statusLabel(status: string): string { return ({ draft: "待审批", approved: "已审批", queued: "排队中", generating: "生成中", building: "构建中", ready: "待确认", confirmed: "已确认", rejected: "已驳回", failed: "失败", cancelled: "已取消", active: "有效", revoked: "已撤销", expired: "已过期", succeeded: "已完成", open: "未解决", resolved: "已解决" } as Record<string, string>)[status] ?? status; }

function FeedbackRow({ item, canEdit, run }: { item: PrototypeFeedback; canEdit: boolean; run: Operation }) {
  const resolve = useResolveWorkbenchPrototypeV2Feedback(item.projectId, item.id);
  return <div className="mt-2 rounded border border-white/[0.1] p-2 text-xs"><p className="whitespace-pre-wrap">{item.body}</p>{item.anchor && <p className="mt-1 text-[#9aa0a6]">{item.anchor.pageId} · {item.anchor.quote || (item.anchor.scope === "node" ? item.anchor.nodeId : "页面")}</p>}<p className="mt-1 text-[#9aa0a6]">{statusLabel(item.status)}</p>{item.status === "open" && <button type="button" disabled={!canEdit || resolve.isPending} onClick={() => void run(() => resolve.mutateAsync({ ifMatch: etag(item), request: {} }), "批注已解决")} className={`${buttonClass} mt-1`}>解决</button>}</div>;
}
function ShareRow({ item, projectId, canEdit, run }: { item: PrototypeShare; projectId: string; canEdit: boolean; run: Operation }) {
  const revoke = useRevokeWorkbenchPrototypeV2Share(projectId, item.id);
  return <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span>{statusLabel(item.status)}</span>{item.status === "active" && <><a href={item.url} target="_blank" rel="noreferrer" className="text-[#b79cff] underline">打开分享链接</a><button type="button" disabled={!canEdit || revoke.isPending} onClick={() => void run(() => revoke.mutateAsync({ ifMatch: etag(item), request: {} }), "分享已撤销")} className={buttonClass}>撤销</button></>}</div>;
}
function ExportRow({ item, projectId, canEdit, run }: { item: PrototypeExport; projectId: string; canEdit: boolean; run: Operation }) {
  const retry = useRetryWorkbenchPrototypeV2Export(projectId, item.id);
  const cancel = useCancelWorkbenchPrototypeV2Export(projectId, item.id);
  const download = useDownloadWorkbenchPrototypeV2Export(projectId, item.id);
  return <div className="mt-2 rounded border border-white/[0.1] p-2 text-xs"><div className="flex flex-wrap items-center gap-2"><span>{item.format.toUpperCase()} · {statusLabel(item.status)}</span>{item.status === "succeeded" && <button type="button" disabled={download.isPending} onClick={() => void run(async () => downloadBlob(await download.mutateAsync(), `prototype-${item.id}.${item.format === "html" ? "html" : "zip"}`), "导出已下载")} className={buttonClass}>下载</button>}{["queued", "building"].includes(item.status) && <button type="button" disabled={!canEdit || cancel.isPending} onClick={() => void run(() => cancel.mutateAsync({ ifMatch: etag(item), request: {} }), "导出已取消")} className={buttonClass}>取消导出</button>}{item.status === "failed" && <button type="button" disabled={!canEdit || retry.isPending} onClick={() => void run(() => retry.mutateAsync({ ifMatch: etag(item), request: {} }), "导出已重试")} className={buttonClass}>重试</button>}</div>{item.failure && <p className="mt-1 text-[#f2a7a7]">{item.failure.detail}</p>}</div>;
}
function downloadBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob); const anchor = document.createElement("a");
  anchor.href = objectUrl; anchor.download = fileName; anchor.style.display = "none";
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
