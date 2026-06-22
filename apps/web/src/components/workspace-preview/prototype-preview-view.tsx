"use client";

import {
  useEffect,
  useMemo,
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
  Code2,
  Crop,
  Layers,
  Loader2,
  MousePointer2,
  PencilLine,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { Badge, Button, IconButton, SegmentedControl } from "@/components/ui";
import { EmptyPreview } from "./empty-preview";
import { derivePrototypeComponents, toChineseText } from "./helpers";
import type {
  CanvasRect,
  Phase1PrototypePreview,
  PrototypeCanvasMode,
  PrototypeCanvasSelection,
  PrototypeComponentNode,
  PrototypeLocalAction,
  PrototypeLocalGeneration,
} from "./types";

const LOCAL_ACTIONS: Array<{ id: PrototypeLocalAction; label: string; icon: LucideIcon }> = [
  { id: "copy_generate", label: "文案生成", icon: PencilLine },
  { id: "visual_refine", label: "视觉优化", icon: Wand2 },
  { id: "layout_adjust", label: "布局调整", icon: Crop },
  { id: "interaction_fill", label: "交互补齐", icon: MousePointer2 },
];

export function PrototypePreviewView({ prototypePreview }: { prototypePreview?: Phase1PrototypePreview | null }) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const canvasOverlayRef = useRef<HTMLDivElement | null>(null);
  const localDialogRef = useRef<HTMLDivElement | null>(null);
  const localInstructionRef = useRef<HTMLTextAreaElement | null>(null);
  const componentNodes = useMemo(
    () => derivePrototypeComponents(prototypePreview?.html ?? ""),
    [prototypePreview?.html],
  );
  const [canvasMode, setCanvasMode] = useState<PrototypeCanvasMode>("select");
  const [activeComponentId, setActiveComponentId] = useState("");
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draftBox, setDraftBox] = useState<CanvasRect | null>(null);
  const [selection, setSelection] = useState<PrototypeCanvasSelection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [localAction, setLocalAction] = useState<PrototypeLocalAction>("copy_generate");
  const [instruction, setInstruction] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generation, setGeneration] = useState<PrototypeLocalGeneration | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);

  useEffect(() => {
    setCanvasMode("select");
    setActiveComponentId("");
    setDragStart(null);
    setDraftBox(null);
    setSelection(null);
    setDialogOpen(false);
    setLocalAction("copy_generate");
    setInstruction("");
    setGenerating(false);
    setGeneration(null);
    setGenerationError(null);
  }, [prototypePreview?.id, prototypePreview?.html]);

  useEffect(() => {
    if (!componentNodes.length) return;
    setActiveComponentId((current) => (
      current && componentNodes.some((node) => node.id === current) ? current : componentNodes[0].id
    ));
  }, [componentNodes]);

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
    const nextSelection: PrototypeCanvasSelection = {
      ...nextRect,
      id: `prototype-selection-${Date.now()}`,
      kind: isBox ? "box" : "point",
      label: selectionLabel(nextRect, isBox ? "box" : "point"),
      createdAt: Date.now(),
    };

    setSelection(nextSelection);
    setDraftBox(null);
    setDragStart(null);
    setDialogOpen(true);
    setInstruction("");
    setLocalAction("copy_generate");
    setGenerationError(null);
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
  };

  const selectComponent = (node: PrototypeComponentNode, index: number) => {
    setActiveComponentId(node.id);
    setCanvasMode("select");
    setDialogOpen(false);
    setGeneration(null);
    setGenerationError(null);

    const bounds = canvasRef.current?.getBoundingClientRect();
    const width = Math.min(280, Math.max(160, (bounds?.width ?? 640) * 0.3));
    const height = Math.min(180, Math.max(96, (bounds?.height ?? 640) * 0.18));
    const maxX = Math.max(8, (bounds?.width ?? 640) - width - 8);
    const maxY = Math.max(8, (bounds?.height ?? 640) - height - 8);
    const nextRect = {
      x: clamp(24 + (index % 3) * 86, 8, maxX),
      y: clamp(32 + index * 48, 8, maxY),
      width,
      height,
    };

    setSelection({
      ...nextRect,
      id: `prototype-component-${node.id}`,
      kind: "box",
      label: `${node.name} 组件选区`,
      createdAt: Date.now(),
    });
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

    try {
      await new Promise((resolve) => window.setTimeout(resolve, 480));
      setGeneration(buildLocalGeneration(selection, localAction, instruction));
    } catch {
      setGenerationError("局部草稿生成失败，请保留选区后重试。");
    } finally {
      setGenerating(false);
    }
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

      <div className="grid min-h-0 flex-1 grid-cols-[174px_minmax(0,1fr)] gap-2 p-2">
        <aside className="flex min-h-0 flex-col rounded-[var(--radius-control)] border border-blue-100 bg-white shadow-[var(--shadow-control)]">
          <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-blue-100 px-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-gray-900">
              <Layers className="h-3.5 w-3.5 text-blue-600" />
              Component Tree
            </div>
            <Badge tone="neutral" className="bg-gray-50">{componentNodes.length}</Badge>
          </div>
          <div className="workbench-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {componentNodes.map((node, index) => {
              const active = node.id === activeComponentId;
              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => selectComponent(node, index)}
                  aria-pressed={active}
                  title={`${node.name} · ${node.type} · ${node.detail}`}
                  className={[
                    "w-full rounded-[10px] border px-2 py-2 text-left transition focus:outline-none focus-visible:ring-3 focus-visible:ring-gray-950/10",
                    active
                      ? "border-blue-200 bg-blue-50 text-blue-900"
                      : "border-transparent bg-white text-gray-600 hover:border-gray-200 hover:bg-gray-50 hover:text-gray-950",
                  ].join(" ")}
                  style={{ paddingLeft: 8 + node.depth * 10 }}
                >
                  <div className="flex items-center gap-2">
                    <span className={["h-2 w-2 shrink-0 rounded-full", active ? "bg-blue-600" : "bg-gray-300"].join(" ")} />
                    <span className="min-w-0 truncate text-xs font-semibold">{node.name}</span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-gray-500">{node.type} · {node.detail}</div>
                </button>
              );
            })}
          </div>
          <PrototypePatchPreview selection={selection} generation={generation} />
        </aside>

        <div className="min-w-0 overflow-hidden rounded-[var(--radius-control)] border border-blue-100 bg-white shadow-[var(--shadow-panel)]">
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
                Patch
              </Badge>
            ) : null}
          </div>
          <div ref={canvasRef} className="relative h-[calc(100%-36px)] min-h-[600px] bg-white">
            <iframe
              title="原型预览"
              srcDoc={prototypePreview.html}
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
          generation={generation}
          generationError={generationError}
          dialogRef={localDialogRef}
          instructionRef={localInstructionRef}
          onActionChange={(value) => {
            setLocalAction(value);
            setGeneration(null);
            setGenerationError(null);
          }}
          onInstructionChange={(value) => {
            setInstruction(value);
            setGeneration(null);
            setGenerationError(null);
          }}
          onClose={() => setDialogOpen(false)}
          onSubmit={generateLocalDraft}
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
  generation,
  generationError,
  dialogRef,
  instructionRef,
  onActionChange,
  onInstructionChange,
  onClose,
  onSubmit,
}: {
  selection: PrototypeCanvasSelection;
  action: PrototypeLocalAction;
  instruction: string;
  generating: boolean;
  generation: PrototypeLocalGeneration | null;
  generationError: string | null;
  dialogRef: RefObject<HTMLDivElement | null>;
  instructionRef: RefObject<HTMLTextAreaElement | null>;
  onActionChange: (value: PrototypeLocalAction) => void;
  onInstructionChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
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
          当前输出会作为局部补丁草稿保留，不覆盖完整原型。
        </div>

        {generating ? <PrototypeLocalSkeleton /> : null}

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
            </div>
            <div className="mt-2 space-y-1.5">
              {generation.changes.map((change) => (
                <div key={change} className="break-words rounded-lg bg-white/80 px-2 py-1.5 text-xs leading-5 text-emerald-900">
                  {change}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="secondary" onClick={onClose} title="收起局部生成编辑器">
            收起
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!instruction.trim() || generating}
            title={generating ? "正在生成局部草稿" : instruction.trim() ? "生成局部草稿" : "请输入局部生成指令"}
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {generating ? "生成中" : "生成局部草稿"}
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

function PrototypePatchPreview({
  selection,
  generation,
}: {
  selection: PrototypeCanvasSelection | null;
  generation: PrototypeLocalGeneration | null;
}) {
  return (
    <div className="shrink-0 border-t border-blue-100 p-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-900">
          <Code2 className="h-3.5 w-3.5 text-blue-600" />
          Patch Preview
        </div>
        <Badge tone={generation ? "success" : selection ? "accent" : "neutral"} className="bg-white">
          {generation ? "已生成" : selection ? "待生成" : "未选区"}
        </Badge>
      </div>
      {generation ? (
        <div className="space-y-1.5">
          {generation.changes.slice(0, 3).map((change) => (
            <div key={change} className="break-words rounded-lg border border-emerald-100 bg-emerald-50 px-2 py-1.5 text-[11px] leading-4 text-emerald-900">
              {change}
            </div>
          ))}
        </div>
      ) : selection ? (
        <div className="rounded-lg border border-blue-100 bg-blue-50 px-2 py-2 text-[11px] leading-4 text-blue-800">
          {selection.label}
        </div>
      ) : (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-2 text-[11px] leading-4 text-gray-500">
          选择画布区域后会展示局部补丁草稿。
        </div>
      )}
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
  const guard = "应用方式：生成局部补丁候选，不替换完整 HTML。";
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
