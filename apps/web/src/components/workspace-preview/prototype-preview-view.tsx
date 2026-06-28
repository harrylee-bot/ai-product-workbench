"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import type { LucideIcon } from "lucide-react";
import {
  CheckCircle2,
  Crop,
  Loader2,
  MousePointer2,
  PencilLine,
  Save,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { Badge, Button, IconButton, SegmentedControl } from "@/components/ui";
import { EmptyPreview } from "./empty-preview";
import { toChineseText } from "./helpers";
import type {
  CanvasRect,
  Phase1PrototypePreview,
  PrototypeCanvasMode,
  PrototypeCanvasSelection,
  PrototypeLocalAction,
  PrototypeLocalGeneration,
} from "./types";

const LOCAL_ACTIONS: Array<{ id: PrototypeLocalAction; label: string; icon: LucideIcon }> = [
  { id: "copy_generate", label: "文案生成", icon: PencilLine },
  { id: "visual_refine", label: "视觉优化", icon: Wand2 },
  { id: "layout_adjust", label: "布局调整", icon: Crop },
  { id: "interaction_fill", label: "交互补齐", icon: MousePointer2 },
];

export function PrototypePreviewView({
  prototypePreview,
}: {
  prototypePreview?: Phase1PrototypePreview | null;
}) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const canvasOverlayRef = useRef<HTMLDivElement | null>(null);
  const localDialogRef = useRef<HTMLDivElement | null>(null);
  const localInstructionRef = useRef<HTMLTextAreaElement | null>(null);
  const [canvasMode, setCanvasMode] = useState<PrototypeCanvasMode>("select");
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draftBox, setDraftBox] = useState<CanvasRect | null>(null);
  const [selection, setSelection] = useState<PrototypeCanvasSelection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [localAction, setLocalAction] = useState<PrototypeLocalAction>("copy_generate");
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generation, setGeneration] = useState<PrototypeLocalGeneration | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);

  useEffect(() => {
    setCanvasMode("select");
    setDragStart(null);
    setDraftBox(null);
    setSelection(null);
    setDialogOpen(false);
    setLocalAction("copy_generate");
    setInstruction("");
    setGenerating(false);
    setGeneration(null);
    setGenerationError(null);
    setDraftSaved(false);
  }, [prototypePreview?.id, prototypePreview?.html]);

  useEffect(() => {
    if (dialogOpen) {
      window.requestAnimationFrame(() => localInstructionRef.current?.focus());
    }
  }, [dialogOpen, selection?.id]);

  useEffect(() => {
    if (!dialogOpen) return;

    const closeDialog = () => {
      setDialogOpen(false);
      window.requestAnimationFrame(() => canvasOverlayRef.current?.focus());
    };

    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (localDialogRef.current?.contains(target)) return;
      closeDialog();
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
      }
    };

    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [dialogOpen]);

  if (!prototypePreview?.html) {
    return (
      <div className="h-full p-4">
        <EmptyPreview
          title="暂无原型"
          description="发送需求后，系统会生成一份网页原型，并在这里直接预览。"
        />
      </div>
    );
  }

  const activeBox = draftBox ?? selection;

  const startSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (canvasMode !== "select" || !canvasRef.current) return;
    event.currentTarget.focus({ preventScroll: true });
    const point = getCanvasPoint(event, canvasRef.current);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(point);
    setDraftBox({ ...point, width: 0, height: 0 });
    setSelection(null);
    setGeneration(null);
    setGenerationError(null);
    setDraftSaved(false);
  };

  const updateSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (canvasMode !== "select" || !dragStart || !canvasRef.current) return;
    const point = getCanvasPoint(event, canvasRef.current);
    setDraftBox(rectFromPoints(dragStart, point));
  };

  const finishSelection = (event: PointerEvent<HTMLDivElement>) => {
    if (canvasMode !== "select" || !dragStart || !canvasRef.current) return;
    const point = getCanvasPoint(event, canvasRef.current);
    const canvasBounds = canvasRef.current.getBoundingClientRect();
    const rawRect = rectFromPoints(dragStart, point);
    const isBox = rawRect.width >= 18 && rawRect.height >= 18;
    const nextRect = isBox ? rawRect : pointSelectionRect(point, canvasBounds.width, canvasBounds.height);
    const hit = findPrototypeComponentHit(iframeRef.current, rectCenter(nextRect));
    const nextSelection: PrototypeCanvasSelection = {
      ...nextRect,
      id: `prototype-selection-${Date.now()}`,
      kind: isBox ? "box" : "point",
      label: hit?.label ?? selectionLabel(nextRect, isBox ? "box" : "point"),
      componentId: hit?.componentId,
      pageId: hit?.pageId,
      componentName: hit?.componentName,
      createdAt: Date.now(),
    };

    setSelection(nextSelection);
    setDraftBox(null);
    setDragStart(null);
    setDialogOpen(true);
    setInstruction("");
    setLocalAction("copy_generate");
    setGenerationError(null);
    setDraftSaved(false);
  };

  const cancelSelectionDrag = () => {
    setDragStart(null);
    setDraftBox(null);
  };

  const clearSelection = () => {
    setSelection(null);
    setDialogOpen(false);
    setInstruction("");
    setGeneration(null);
    setGenerationError(null);
    setDraftSaved(false);
  };

  const createKeyboardSelection = () => {
    if (!canvasRef.current) return;
    const bounds = canvasRef.current.getBoundingClientRect();
    const nextRect = pointSelectionRect(
      { x: bounds.width / 2, y: Math.min(bounds.height / 2, 360) },
      bounds.width,
      bounds.height,
    );

    setSelection({
      ...nextRect,
      id: `prototype-keyboard-selection-${Date.now()}`,
      kind: "point",
      label: selectionLabel(nextRect, "point"),
      createdAt: Date.now(),
    });
    setDraftBox(null);
    setDragStart(null);
    setDialogOpen(true);
    setInstruction("");
    setLocalAction("copy_generate");
    setGeneration(null);
    setGenerationError(null);
    setDraftSaved(false);
  };

  const handleCanvasKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      if (selection || draftBox || dialogOpen) {
        event.preventDefault();
        cancelSelectionDrag();
        clearSelection();
      }
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      createKeyboardSelection();
    }
  };

  const generateLocalDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selection || !instruction.trim()) return;
    setGenerating(true);
    setGeneration(null);
    setGenerationError(null);
    setDraftSaved(false);

    try {
      await new Promise((resolve) => window.setTimeout(resolve, 480));
      setGeneration(buildLocalGeneration(selection, localAction, instruction));
    } catch {
      setGenerationError("局部草稿生成失败，请保留选区后重试。");
    } finally {
      setGenerating(false);
    }
  };

  const saveLocalDraft = () => {
    if (!selection || !generation) return;
    setDraftSaved(true);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-[var(--color-accent-soft)]">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-blue-100 bg-white/80 px-3 backdrop-blur">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-950">{toChineseText(prototypePreview.title)}</div>
          <div className="truncate text-xs text-gray-500">
            {selection ? selection.label : canvasMode === "select" ? "画布选择" : "网页原型预览"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SegmentedControl
            value={canvasMode}
            onChange={setCanvasMode}
            ariaLabel="原型画布模式"
            className="bg-blue-50"
            options={[
              { value: "browse", label: "浏览", icon: <MousePointer2 className="h-3.5 w-3.5" /> },
              { value: "select", label: "选择", icon: <Crop className="h-3.5 w-3.5" /> },
            ]}
          />
          <Badge tone="accent" className="bg-white">已生成</Badge>
        </div>
      </div>

      <div className="min-h-0 flex-1 p-2">
        <div className="h-full min-w-0 overflow-hidden rounded-[var(--radius-control)] border border-blue-100 bg-white shadow-[var(--shadow-panel)]">
          <div className="flex h-9 items-center gap-2 border-b border-blue-100 bg-gray-50 px-3">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
            <span className="ml-2 truncate text-xs text-gray-500">{prototypePreview.entryFilePath ?? "index.html"}</span>
            {selection ? (
              <Badge tone="accent" className="ml-auto bg-white">
                {selection.kind === "box" ? "框选" : "点选"}
              </Badge>
            ) : null}
            {generation ? (
              <Badge tone="success" className={selection ? "gap-1" : "ml-auto gap-1"}>
                <CheckCircle2 className="h-3.5 w-3.5" />
                草稿
              </Badge>
            ) : null}
          </div>
          <div ref={canvasRef} className="relative h-[calc(100%-36px)] min-h-[600px] bg-white">
            <iframe
              ref={iframeRef}
              title="原型预览"
              srcDoc={prototypePreview.html}
              // 安全：仅 allow-scripts，不加 allow-same-origin（sec-1/sandbox-1）。
              // 同源+脚本会让注入的脚本读取父域 localStorage 里的 JWT。选区命中改为 contentDocument
              // 不可用时降级返回 null（局部编辑功能受影响，后续可改 postMessage 协议恢复）。
              sandbox="allow-scripts"
              className={[
                "h-full min-h-[600px] w-full border-0 bg-white",
                canvasMode === "select" ? "pointer-events-none select-none" : "",
              ].join(" ")}
            />

            {canvasMode === "select" ? (
              <div
                ref={canvasOverlayRef}
                role="group"
                tabIndex={0}
                aria-label="原型画布选区层，按 Enter 创建中心选区，按 Escape 清除选区"
                className="absolute inset-0 z-10 cursor-crosshair bg-blue-500/0"
                onPointerDown={startSelection}
                onPointerMove={updateSelection}
                onPointerUp={finishSelection}
                onPointerCancel={cancelSelectionDrag}
                onPointerLeave={cancelSelectionDrag}
                onKeyDown={handleCanvasKeyDown}
              >
                {activeBox ? <PrototypeSelectionBox box={activeBox} selected={Boolean(selection && !draftBox)} /> : null}

                {selection && !draftBox ? (
                  <div
                    className="absolute z-20 flex items-center gap-1 rounded-full border border-blue-200 bg-white p-1 shadow-[var(--shadow-float)]"
                    style={{
                      left: clamp(selection.x, 8, Math.max(8, selection.x + selection.width - 236)),
                      top: Math.max(8, selection.y - 44),
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setLocalAction("copy_generate");
                        setGenerationError(null);
                        setDialogOpen(true);
                      }}
                      title="生成选区文案"
                      className="h-8 rounded-full px-3 text-xs"
                    >
                      文案
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => {
                        setLocalAction("visual_refine");
                        setGenerationError(null);
                        setDialogOpen(true);
                      }}
                      title="打开局部生成编辑器"
                      className="h-8 rounded-full px-3 text-xs"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      局部生成
                    </Button>
                    <IconButton label="清除选区" onClick={clearSelection} className="h-8 w-8 rounded-full">
                      <X className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {dialogOpen && selection ? (
        <PrototypeLocalEditDialog
          selection={selection}
          action={localAction}
          instruction={instruction}
          generating={generating}
          remoteGenerating={false}
          generation={generation}
          generationError={generationError}
          draftSaved={draftSaved && Boolean(generation)}
          dialogRef={localDialogRef}
          instructionRef={localInstructionRef}
          onActionChange={(value) => {
            setLocalAction(value);
            setGeneration(null);
            setGenerationError(null);
            setDraftSaved(false);
          }}
          onInstructionChange={(value) => {
            setInstruction(value);
            setGeneration(null);
            setGenerationError(null);
            setDraftSaved(false);
          }}
          onClose={() => setDialogOpen(false)}
          onSubmit={generateLocalDraft}
          onSaveDraft={saveLocalDraft}
        />
      ) : null}
    </div>
  );
}

function PrototypeSelectionBox({ box, selected }: { box: CanvasRect; selected: boolean }) {
  return (
    <div
      className={[
        "absolute rounded-[10px] border bg-blue-500/10 shadow-[0_0_0_9999px_rgba(15,23,42,0.03)]",
        selected ? "border-blue-600 ring-4 ring-blue-500/15" : "border-blue-500",
      ].join(" ")}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      <span className="absolute -left-px -top-7 rounded-md border border-blue-200 bg-white px-2 py-1 text-xs font-semibold text-blue-700 shadow-[var(--shadow-control)]">
        {selectionLabel(box, selected ? "box" : "point")}
      </span>
      {selected ? (
        <>
          <span className="absolute -left-1.5 -top-1.5 h-3 w-3 rounded-full border border-blue-600 bg-white" />
          <span className="absolute -right-1.5 -top-1.5 h-3 w-3 rounded-full border border-blue-600 bg-white" />
          <span className="absolute -bottom-1.5 -left-1.5 h-3 w-3 rounded-full border border-blue-600 bg-white" />
          <span className="absolute -bottom-1.5 -right-1.5 h-3 w-3 rounded-full border border-blue-600 bg-white" />
        </>
      ) : null}
    </div>
  );
}

function PrototypeLocalEditDialog({
  selection,
  action,
  instruction,
  generating,
  remoteGenerating,
  generation,
  generationError,
  draftSaved,
  dialogRef,
  instructionRef,
  onActionChange,
  onInstructionChange,
  onClose,
  onSubmit,
  onSaveDraft,
}: {
  selection: PrototypeCanvasSelection;
  action: PrototypeLocalAction;
  instruction: string;
  generating: boolean;
  remoteGenerating: boolean;
  generation: PrototypeLocalGeneration | null;
  generationError: string | null;
  draftSaved: boolean;
  dialogRef: RefObject<HTMLDivElement | null>;
  instructionRef: RefObject<HTMLTextAreaElement | null>;
  onActionChange: (value: PrototypeLocalAction) => void;
  onInstructionChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSaveDraft: () => void;
}) {
  const busy = generating || remoteGenerating;
  const submitTitle = busy
    ? "正在生成局部草稿"
    : !instruction.trim()
      ? "请输入局部生成指令"
      : generation
        ? "重新生成局部草稿"
        : "生成局部草稿";
  const submitLabel = busy ? "生成中" : generation ? "重新生成" : "生成局部草稿";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-label="局部生成"
      aria-describedby="prototype-local-edit-help"
      className="absolute right-3 top-14 z-30 w-[360px] max-w-[calc(100%-24px)] overflow-hidden rounded-[14px] border border-gray-200 bg-white shadow-[var(--shadow-float)]"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
            <Sparkles className="h-4 w-4 text-blue-600" />
            局部生成
          </div>
          <div className="mt-1 truncate text-xs text-gray-500" title={selection.label}>{selection.label}</div>
        </div>
        <IconButton label="关闭" onClick={onClose} className="h-8 w-8 shrink-0 rounded-full">
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      <form onSubmit={onSubmit} className="space-y-2.5 px-3 py-2.5">
        <div className="grid grid-cols-2 gap-2" role="tablist" aria-label="局部生成动作">
          {LOCAL_ACTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={action === item.id}
                onClick={() => onActionChange(item.id)}
                title={item.label}
                className={[
                  "flex h-9 items-center justify-center gap-1.5 rounded-[10px] border px-2 text-xs font-semibold transition focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
                  action === item.id
                    ? "border-blue-200 bg-blue-50 text-blue-700"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50 hover:text-gray-950",
                ].join(" ")}
              >
                <Icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            );
          })}
        </div>

        <textarea
          ref={instructionRef}
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          placeholder="描述这个局部区域要生成或调整的内容"
          aria-label="局部生成指令"
          rows={4}
          className="block max-h-[140px] min-h-[96px] w-full resize-none rounded-[12px] border border-gray-200 bg-gray-50 px-3 py-2 text-sm leading-6 text-gray-900 shadow-none outline-none transition placeholder:text-gray-400 focus:border-gray-950 focus:bg-white focus:ring-3 focus:ring-gray-950/10"
        />

        <div id="prototype-local-edit-help" className="rounded-[12px] border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
          当前输出会作为局部修改草稿保留，不覆盖完整原型。
        </div>

        {busy ? <PrototypeLocalSkeleton /> : null}

        {generationError ? (
          <div role="alert" className="rounded-[12px] border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
            {generationError}
          </div>
        ) : null}

        {generation ? (
          <div className="rounded-[12px] border border-emerald-200 bg-emerald-50 px-3 py-3" aria-live="polite">
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 className="h-4 w-4" />
              {generation.title}
              {draftSaved ? <Badge tone="success" className="ml-auto bg-white">已保存</Badge> : null}
            </div>
            <div className="mt-2 space-y-1.5">
              {generation.changes.map((change) => (
                <div key={change} className="break-words rounded-lg bg-white/80 px-2 py-1.5 text-xs leading-5 text-emerald-900">
                  {change}
                </div>
              ))}
            </div>
            {/* gate-edit-1：当前局部生成为前端演示草稿，未调用后端真实生成接口。需重新生成才生效。 */}
            <div className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] leading-5 text-amber-800">
              演示草稿：此内容为本地预览，未真正改写原型。请在对话框描述修改后重新生成以生效。
            </div>
          </div>
        ) : null}

        {draftSaved ? (
          <div role="status" className="rounded-[12px] border border-emerald-200 bg-white px-3 py-2 text-xs font-semibold leading-5 text-emerald-800">
            局部草稿已保存。
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="secondary" onClick={onClose} title="收起局部生成编辑器">
            收起
          </Button>
          {generation ? (
            <Button
              type="button"
              size="sm"
              variant={draftSaved ? "secondary" : "primary"}
              onClick={onSaveDraft}
              disabled={draftSaved}
              title={draftSaved ? "局部草稿已保存" : "保存当前局部草稿"}
            >
              {draftSaved ? <CheckCircle2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}
              {draftSaved ? "已保存" : "保存草稿"}
            </Button>
          ) : null}
          <Button
            type="submit"
            size="sm"
            variant={generation ? "secondary" : "primary"}
            disabled={!instruction.trim() || busy}
            title={submitTitle}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}

function PrototypeLocalSkeleton() {
  return (
    <div className="rounded-[12px] border border-gray-200 bg-white px-3 py-3" aria-live="polite" aria-label="局部草稿生成中">
      <div className="h-3 w-28 animate-pulse rounded-full bg-gray-200" />
      <div className="mt-3 space-y-2">
        <div className="h-3 animate-pulse rounded-full bg-gray-100" />
        <div className="h-3 w-10/12 animate-pulse rounded-full bg-gray-100" />
        <div className="h-3 w-7/12 animate-pulse rounded-full bg-gray-100" />
      </div>
    </div>
  );
}

function getCanvasPoint(event: PointerEvent<HTMLDivElement>, element: HTMLDivElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: clamp(event.clientX - rect.left, 0, rect.width),
    y: clamp(event.clientY - rect.top, 0, rect.height),
  };
}

function rectFromPoints(start: { x: number; y: number }, end: { x: number; y: number }): CanvasRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function pointSelectionRect(point: { x: number; y: number }, canvasWidth: number, canvasHeight: number): CanvasRect {
  const width = Math.min(240, Math.max(144, canvasWidth * 0.24));
  const height = Math.min(156, Math.max(96, canvasHeight * 0.18));
  return {
    x: clamp(point.x - width / 2, 8, Math.max(8, canvasWidth - width - 8)),
    y: clamp(point.y - height / 2, 8, Math.max(8, canvasHeight - height - 8)),
    width,
    height,
  };
}

function rectCenter(rect: CanvasRect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function findPrototypeComponentHit(iframe: HTMLIFrameElement | null, point: { x: number; y: number }) {
  const doc = iframe?.contentDocument;
  if (!doc) return null;
  const element = doc.elementFromPoint(point.x, point.y);
  if (!element) return null;
  const component = element.closest("[data-component-id]");
  if (!component) return null;
  const componentId = component.getAttribute("data-component-id");
  if (!componentId) return null;
  const page = component.closest("[data-page-id]");
  const pageId = page?.getAttribute("data-page-id") ?? component.getAttribute("data-page-id") ?? undefined;
  const componentName = readableComponentName(component);
  return {
    componentId,
    pageId,
    componentName,
    label: componentName ? `组件：${componentName}` : `组件：${componentId}`,
  };
}

function readableComponentName(element: Element) {
  const heading = element.querySelector("strong,h1,h2,h3,button");
  const text = (heading?.textContent || element.getAttribute("aria-label") || element.textContent || "").trim();
  return text.replace(/\s+/g, " ").slice(0, 32);
}

function selectionLabel(box: CanvasRect, kind: "point" | "box") {
  const prefix = kind === "point" ? "点击选区" : "框选区域";
  return `${prefix} ${Math.round(box.width)}×${Math.round(box.height)}`;
}

function buildLocalGeneration(
  selection: PrototypeCanvasSelection,
  action: PrototypeLocalAction,
  instruction: string,
): PrototypeLocalGeneration {
  const actionLabel = localActionLabel(action);
  const cleanInstruction = instruction.trim();
  return {
    title: `${actionLabel}草稿已生成`,
    changes: localDraftChanges(selection, action, cleanInstruction),
  };
}

function localActionLabel(action: PrototypeLocalAction) {
  return LOCAL_ACTIONS.find((item) => item.id === action)?.label ?? "局部生成";
}

function localDraftChanges(
  selection: PrototypeCanvasSelection,
  action: PrototypeLocalAction,
  instruction: string,
) {
  const scope = `作用范围：${selection.label}`;
  const guard = "应用方式：生成局部修改建议，不替换完整 HTML。";
  if (action === "copy_generate") {
    return [
      scope,
      `主文案：围绕「${instruction}」生成更明确的标题与一句核心说明。`,
      "按钮文案：补充 1 个主行动和 1 个次级行动，保持当前布局不变。",
      guard,
    ];
  }
  if (action === "visual_refine") {
    return [
      scope,
      `视觉层级：针对「${instruction}」强化选区内的标题、说明与按钮优先级。`,
      "样式策略：只调整局部间距、对比度、边框与阴影，不触碰页面外层结构。",
      guard,
    ];
  }
  if (action === "layout_adjust") {
    return [
      scope,
      `布局草案：根据「${instruction}」重排选区内部信息块。`,
      "约束：保留选区外的导航、页面容器和其它模块位置。",
      guard,
    ];
  }
  return [
    scope,
    `交互补齐：为「${instruction}」补充局部状态、反馈和异常提示。`,
    "状态范围：只影响选区内控件的 hover、loading、empty 或 error 表达。",
    guard,
  ];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
