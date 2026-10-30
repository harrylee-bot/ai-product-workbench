"use client";

import { JSONUIProvider, Renderer, type ComponentRenderProps, type RendererProps } from "@json-render/react";
import type { GenerationPreview, GenerationPreviewNode, Run, RunGenerationStage } from "@workbench/workbench-contracts";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Streamdown } from "streamdown";
import { WorkbenchArtifactContent, type WorkbenchArtifactReference } from "./workbench-artifact-content";

type GenerationActivity = {
  id: string;
  detail: string | null;
  label: string;
  status: string;
};

const GENERATION_STAGE_LABELS: Partial<Record<RunGenerationStage, string>> = {
  thinking: "理解需求",
  "collecting-prd-context": "整理资料",
  "structuring-prd": "规划结构",
  "drafting-prd": "编写需求文档",
  "validating-prd": "检查需求文档",
  "design-system": "生成设计系统",
  "mapping-components": "映射界面组件",
  "creating-flows": "创建用户流程",
  "generating-ui": "生成界面",
  "screen-streaming": "流式生成页面",
  summarizing: "整理生成结果",
  "screen-stable": "稳定画布",
};

const ACTIVE_RUN_STATUSES: ReadonlySet<Run["status"]> = new Set([
  "queued",
  "running",
  "waiting_input",
  "cancelling",
]);

const PRD_STAGE_STEPS: Array<{ stage: RunGenerationStage; label: string; summary: string }> = [
  { stage: "thinking", label: "理解需求", summary: "确认目标、范围和交付物" },
  { stage: "collecting-prd-context", label: "整理资料", summary: "读取已授权的项目资料与知识库" },
  { stage: "structuring-prd", label: "规划结构", summary: "组织背景、业务规则和验收关系" },
  { stage: "drafting-prd", label: "编写文档", summary: "把结构整理成可编辑的需求文档" },
  { stage: "validating-prd", label: "检查文档", summary: "核对字段、引用、验收和安全边界" },
];

const PROTOTYPE_STAGE_STEPS: Array<{ stage: RunGenerationStage; label: string; summary: string }> = [
  { stage: "thinking", label: "理解需求", summary: "确认目标、范围和交付物" },
  { stage: "design-system", label: "设计系统", summary: "确定颜色、间距和组件层级" },
  { stage: "mapping-components", label: "映射组件", summary: "把需求映射到页面结构和组件" },
  { stage: "creating-flows", label: "串联流程", summary: "串联关键路径、状态和反馈" },
  { stage: "generating-ui", label: "生成界面", summary: "生成首屏和关键交互状态" },
  { stage: "screen-streaming", label: "流式补齐", summary: "逐步补齐页面内容和细节" },
  { stage: "summarizing", label: "整理结果", summary: "整理页面说明与生成结果" },
  { stage: "screen-stable", label: "稳定画布", summary: "准备把最终版本回写到画布" },
];

const PROTOTYPE_STAGES = new Set<RunGenerationStage>(PROTOTYPE_STAGE_STEPS.filter((step) => step.stage !== "thinking").map((step) => step.stage));

function processSteps(
  generationStage: RunGenerationStage | null,
  motionKind: "neutral" | "prd" | "prototype",
) {
  const prototype = motionKind === "prototype" || (generationStage !== null && PROTOTYPE_STAGES.has(generationStage));
  return prototype ? PROTOTYPE_STAGE_STEPS : PRD_STAGE_STEPS;
}

function stepState(
  step: { stage: RunGenerationStage },
  generationStage: RunGenerationStage | null,
  steps: ReadonlyArray<{ stage: RunGenerationStage }>,
) {
  if (!generationStage) return "pending";
  const current = steps.findIndex((candidate) => candidate.stage === generationStage);
  const index = steps.findIndex((candidate) => candidate.stage === step.stage);
  if (current < 0 || index < 0) return "pending";
  if (index < current) return "done";
  if (index === current) return "active";
  return "pending";
}

function isActiveRun(status: Run["status"] | null): boolean {
  return status !== null && ACTIVE_RUN_STATUSES.has(status);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function PreviewNode({ element, children }: ComponentRenderProps<{ node: GenerationPreviewNode }>) {
  const node = element.props.node;
  const container = node.kind === "frame" || node.kind === "form";
  const style: CSSProperties = {
    position: node.absolute ? "absolute" : "relative",
    left: node.absolute ? node.x : undefined, top: node.absolute ? node.y : undefined,
    width: node.width ?? undefined, minHeight: node.height ?? undefined,
    flexShrink: 0, display: container ? "flex" : "block", flexDirection: node.direction,
    gap: node.gap, padding: node.padding, borderRadius: node.radius,
    background: node.fill ?? undefined, color: node.color ?? "#202124",
    fontSize: node.fontSize ?? 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
  };
  if (node.kind === "input") return <input aria-label={node.text || "输入框"} disabled placeholder={node.text} style={style} className="border border-[#d7dbe1] px-3 py-2" />;
  if (node.kind === "button") return <button disabled style={style} className="border border-[#d7dbe1] px-3 py-2">{node.text}{children}</button>;
  if (node.kind === "image" || node.kind === "icon") return <div aria-label={node.text} role="img" style={style} className="border border-[#e8eaed] bg-[#f1f3f4]" />;
  return <div style={style}>{container ? null : node.text}{children}</div>;
}

const registry = {
  Node: PreviewNode,
  Screen: ({ children }: ComponentRenderProps) => <>{children}</>,
};

export function generationPreviewTree(nodes: GenerationPreviewNode[]): NonNullable<RendererProps["tree"]> {
  const root = "preview-screen";
  const elements: NonNullable<RendererProps["tree"]>["elements"] = Object.create(null);
  elements[root] = { key: root, type: "Screen", props: {}, children: [] };
  const unique = new Map(nodes.map((node) => [node.id, node]));
  // Build only reachable nodes. Cycles in unfinished source data cannot recurse.
  const pending = [...unique.values()];
  for (let pass = 0; pass <= nodes.length && pending.length; pass += 1) {
    let added = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const node = pending[index]!;
      const parent = node.parentId && unique.has(node.parentId) ? `n:${node.parentId}` : root;
      if (!elements[parent] || parent === `n:${node.id}`) continue;
      const key = `n:${node.id}`;
      elements[key] = { key, type: "Node", props: { node }, children: [] };
      elements[parent]!.children!.unshift(key);
      pending.splice(index, 1);
      added = true;
    }
    if (!added) break;
  }
  return { root, elements };
}

export function WorkbenchGenerationPreview({
  canCancel = false,
  finalArtifactReferences = [],
  generationStage = null,
  onCancel,
  previews,
  previewTitle,
  activities = [],
  motionKind = "neutral",
  runId = null,
  runStatus = null,
}: {
  canCancel?: boolean;
  finalArtifactReferences?: WorkbenchArtifactReference[];
  generationStage?: RunGenerationStage | null;
  onCancel?: () => void;
  previews: GenerationPreview[];
  previewTitle?: string;
  activities?: readonly GenerationActivity[];
  motionKind?: "neutral" | "prd" | "prototype";
  runId?: string | null;
  runStatus?: Run["status"] | null;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [selectedFinalIndex, setSelectedFinalIndex] = useState(0);
  const [finalPreviewDismissed, setFinalPreviewDismissed] = useState(false);
  const [selectedScreenId, setSelectedScreenId] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const [elapsedMilliseconds, setElapsedMilliseconds] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const activeRun = isActiveRun(runStatus);
  const finalPreview = runStatus === "succeeded" && finalArtifactReferences.length > 0 && !finalPreviewDismissed;
  const finalArtifact = finalArtifactReferences[selectedFinalIndex] ?? finalArtifactReferences[0];
  const [processOpen, setProcessOpen] = useState(true);
  const preview = previews.find((item) => item.artifactIndex === selectedIndex) ?? previews.at(-1);
  const activeScreen = preview?.screens.find((item) => item.id === selectedScreenId) ?? preview?.screens[0];
  const steps = processSteps(generationStage, motionKind);
  const structure = preview?.kind === "prd"
    ? [...new Set((preview.markdown.match(/^#{1,6} .+$/gm) ?? []).map((line) => line.replace(/^#+ /, "")))].slice(0, 8)
    : preview?.screens.map((screen) => screen.name).filter(Boolean) ?? [];
  const statusLabel = finalPreview ? "已完成 · 最终版本"
    : runStatus === "queued" ? "等待开始" : runStatus === "waiting_input" ? "等待你的补充"
      : runStatus === "cancelling" ? "正在取消" : "正在生成 · 实时预览";
  const evidence = activities.filter((activity) => activity.id.startsWith("knowledge:")).slice(-6);

  useEffect(() => {
    setFinalPreviewDismissed(false);
    setSelectedFinalIndex(0);
  }, [runId]);

  useEffect(() => {
    if (selectedFinalIndex >= finalArtifactReferences.length) setSelectedFinalIndex(0);
  }, [finalArtifactReferences.length, selectedFinalIndex]);

  useEffect(() => {
    if (!activeRun) {
      startedAtRef.current = null;
      setElapsedMilliseconds(0);
      return;
    }
    startedAtRef.current ??= Date.now();
    const update = () => setElapsedMilliseconds(Date.now() - (startedAtRef.current ?? Date.now()));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [activeRun]);

  useEffect(() => {
    if (selectedIndex !== null && !previews.some((item) => item.artifactIndex === selectedIndex)) {
      setSelectedIndex(null);
    }
  }, [previews, selectedIndex]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || preview?.kind !== "prototype") return;
    const measure = () => {
      if (viewport.clientWidth > 40) setAvailableWidth(viewport.clientWidth - 40);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [preview?.kind]);
  useEffect(() => {
    const viewport = scrollRef.current;
    if (viewport && followRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [preview?.markdown]);
  if (!preview && !activeRun && !finalPreview) return null;
  const scale = activeScreen && availableWidth ? Math.min(1, availableWidth / activeScreen.width) : 1;
  return (
    <section
      aria-label={finalPreview ? "生成结果预览" : "生成中预览"}
      className="pointer-events-auto absolute bottom-[164px] right-[24px] top-[86px] z-50 flex w-[min(620px,calc(100%_-_400px))] flex-col overflow-hidden rounded-[14px] border border-[#7467f6]/60 bg-[#18191b] shadow-[0_24px_90px_-30px_#000] max-lg:right-[16px] max-lg:w-[min(560px,calc(100%_-_32px))] max-sm:bottom-[136px] max-sm:left-[12px] max-sm:right-[12px] max-sm:top-[112px] max-sm:w-auto"
      data-workbench-generation-preview={finalPreview ? "final" : preview?.kind ?? "pending"}
      data-workbench-generation-preview-layout="dock"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
        <span className={finalPreview ? "size-2 rounded-full bg-[#9de5b0]" : "size-2 rounded-full bg-[#a69cff] motion-safe:animate-pulse"} />
        <span className="text-xs text-[#c8c3ff]" role="status">
          {statusLabel}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#f1f3f4]">
          {finalPreview ? "最终产物" : preview?.title ?? previewTitle ?? "正在准备预览"}
        </span>
        {activeRun && (
          <span className="text-[11px] tabular-nums text-[#aeb3bb]">
            {GENERATION_STAGE_LABELS[generationStage ?? "thinking"] ?? "准备中"} · {formatElapsed(elapsedMilliseconds)}
          </span>
        )}
        {activeRun && canCancel && onCancel && (
          <button
            aria-label="取消生成"
            className="rounded-md border border-white/10 px-2 py-1 text-xs text-[#c8c3ff] transition hover:bg-white/10 hover:text-white"
            disabled={runStatus === "cancelling"}
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
        )}
        {finalPreview && (
          <button
            aria-label="关闭最终预览"
            className="rounded-md border border-white/10 px-2 py-1 text-xs text-[#c8c3ff] transition hover:bg-white/10 hover:text-white"
            onClick={() => setFinalPreviewDismissed(true)}
            type="button"
          >
            关闭
          </button>
        )}
        {previews.length > 1 && previews.map((item) => <button aria-pressed={preview?.artifactIndex === item.artifactIndex} className="rounded bg-white/10 px-2 py-1 text-xs text-white" key={item.artifactIndex} onClick={() => setSelectedIndex(item.artifactIndex)} type="button">{item.kind === "prd" ? "文档" : "原型"}</button>)}
        {finalPreview && finalArtifactReferences.length > 1 && finalArtifactReferences.map((reference, index) => (
          <button
            aria-pressed={finalArtifact === reference}
            className="rounded bg-white/10 px-2 py-1 text-xs text-white"
            key={`${reference.artifactId}:${reference.artifactVersionId}`}
            onClick={() => setSelectedFinalIndex(index)}
            type="button"
          >
            结果 {index + 1}
          </button>
        ))}
      </header>
      {preview?.kind === "prototype" && preview.screens.length > 1 && <nav aria-label="生成中的页面" className="flex shrink-0 gap-2 overflow-x-auto px-4 py-2">{preview.screens.map((screen) => <button aria-pressed={activeScreen?.id === screen.id} className="shrink-0 rounded bg-white/10 px-3 py-1 text-xs text-white" key={screen.id} onClick={() => setSelectedScreenId(screen.id)} type="button">{screen.name}</button>)}</nav>}
      {activeRun && (
        <div className="flex min-h-0 max-h-[55%] shrink-0 flex-col border-b border-white/10 bg-[#202125] text-[#d8dbe1]">
          <button
            aria-expanded={processOpen}
            className="flex w-full items-center justify-between px-4 py-2 text-left text-xs font-medium hover:bg-white/[0.04]"
            onClick={() => setProcessOpen((open) => !open)}
            type="button"
          >
            <span>生成过程</span>
            <span className="text-[11px] text-[#9da3ad]">{processOpen ? "收起" : "展开"}</span>
          </button>
          {processOpen && (
            <div className="min-h-0 space-y-3 overflow-y-auto px-4 pb-3">
              {structure.length > 0 && (
                <div className="rounded-md border border-white/[0.06] px-3 py-2 text-xs text-[#b9bec7]">
                  <p className="font-medium">{preview?.kind === "prd" ? "当前文档结构" : "当前页面结构"}</p>
                  <ul className="mt-1 space-y-1">{structure.map((title) => <li key={title}>{title}</li>)}</ul>
                  <p className="mt-2 text-[#9da3ad]">根据当前草稿更新，尚未定稿。</p>
                </div>
              )}
              {evidence.length > 0 && (
                <div className="rounded-md border border-white/[0.06] px-3 py-2">
                  <p className="text-xs font-medium text-[#b9bec7]">参考资料 · 最近检索</p>
                  <ul className="mt-1 space-y-2 text-xs leading-5 text-[#b9bec7]">
                    {evidence.map((activity) => <li className="whitespace-pre-wrap break-words" key={activity.id}>
                      <span className="font-medium">{activity.status === "running" ? "检索中" : activity.status === "succeeded" ? "检索已返回" : "检索未完成"}</span>
                      {activity.detail ? `\n${activity.detail}` : ""}
                    </li>)}
                  </ul>
                </div>
              )}
              <ol className="grid gap-2 sm:grid-cols-2">
                {steps.map((step) => {
                  const state = stepState(step, generationStage, steps);
                  return (
                    <li className="flex gap-2 rounded-md border border-white/[0.06] bg-white/[0.025] px-2.5 py-2" data-generation-step={step.stage} data-generation-step-state={state} key={step.stage}>
                      <span className={state === "done" ? "text-[#9de5b0]" : state === "active" ? "text-[#c8c3ff]" : "text-[#7d838d]"}>{state === "done" ? "✓" : state === "active" ? "•" : "○"}</span>
                      <span className="min-w-0">
                        <span className="block text-[11px] font-medium">{step.label}{state === "active" ? " · 进行中" : state === "done" ? " · 已完成" : " · 待进行"}</span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-[#9da3ad]">{step.summary}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-[#f1f3f4] p-5 text-[#202124]" ref={scrollRef} onScroll={(event) => { const node = event.currentTarget; followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
        {finalPreview && finalArtifact ? (
          <div className="min-h-[520px] overflow-hidden rounded bg-[#1d1d1f] shadow-sm" data-workbench-generation-final-content>
            <WorkbenchArtifactContent reference={finalArtifact} />
          </div>
        ) : !preview ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-4 rounded bg-white p-8 text-center shadow-sm">
            <p className="text-sm text-[#5f6368]">{GENERATION_STAGE_LABELS[generationStage ?? "thinking"] ?? "准备中"}，首个内容片段到达后会立即显示。</p>
            <p className="text-xs leading-5 text-[#80868b]">可以先查看上方的生成过程。完成后，最终文档或原型会自动呈现在画布上。</p>
            {elapsedMilliseconds >= 60_000 && <p className="text-xs leading-5 text-[#80868b]">本阶段仍在处理，你可以返回项目列表，稍后继续查看。</p>}
          </div>
        ) : preview.kind === "prd" ? <article className="prose prose-sm mx-auto max-w-none rounded bg-white p-7 shadow-sm [&_table]:text-xs"><h1 className="mb-5 text-xl font-semibold">{preview.title}</h1><Streamdown controls={false} isAnimating skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{preview.markdown}</Streamdown></article>
          : activeScreen ? <div className="relative mx-auto overflow-hidden bg-white shadow-sm" style={{ width: activeScreen.width * scale, minHeight: activeScreen.height * scale }}><div className="relative" style={{ width: activeScreen.width, minHeight: activeScreen.height, transform: `scale(${scale})`, transformOrigin: "top left" }}><JSONUIProvider registry={registry}><Renderer tree={generationPreviewTree(activeScreen.nodes)} registry={registry} loading /></JSONUIProvider></div></div>
            : <p className="text-sm text-[#5f6368]">正在构建页面结构…</p>}
      </div>
    </section>
  );
}
