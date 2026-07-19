"use client";

import { useReactFlow } from "@xyflow/react";
import {
  CheckCircle2Icon,
  FrameIcon,
  HandIcon,
  HelpCircleIcon,
  ImageIcon,
  MoreHorizontalIcon,
  MousePointer2Icon,
  PaletteIcon,
  PencilIcon,
  Redo2Icon,
  StarsIcon,
  Undo2Icon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { getStroke } from "perfect-freehand";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComponentType,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  SVGProps,
} from "react";
import { cn } from "@/lib/utils";
import type {
  CanvasInteractionMode,
  CanvasMainCommand,
  CanvasMoreCommand,
  CanvasPanel,
} from "@/lib/workbench/canvas-tools";
import {
  appendBoardDrawingGestureSample,
  boardDrawingDraftStrokeSize,
  boardDrawingUsesSimulatedPressure,
  normalizeBoardDrawingPressure,
  type BoardDrawingSample,
  type BoardRect,
  type CreateBoardDrawingOptions,
} from "@/lib/workbench/features/board";
import { openWorkbenchKnowledgePage } from "@/lib/workbench/product-links";
import {
  floatingToolScale,
  floatingToolTransition,
  panelTransition,
  popoverTransition,
  workbenchEase,
} from "./workbench-motion";
import { freehandOutlinePath } from "./workbench-board-nodes";

const toolItems: Array<{
  id: CanvasMainCommand;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
}> = [
  { id: "select", icon: MousePointer2Icon, label: "Select" },
  { id: "marquee", icon: FrameIcon, label: "Marquee" },
  { id: "direct-edit", icon: PencilIcon, label: "Direct edit" },
  { id: "pan", icon: HandIcon, label: "Pan" },
  { id: "media", icon: ImageIcon, label: "Media" },
  { id: "design-system", icon: PaletteIcon, label: "Design system" },
  { id: "favourites", icon: StarsIcon, label: "Favourites" },
];

type BoardToolGesture =
  | {
      kind: "frame";
      pointerId: number;
      startLocal: { x: number; y: number };
      currentLocal: { x: number; y: number };
      startFlow: { x: number; y: number };
      currentFlow: { x: number; y: number };
    }
  | {
      kind: "drawing";
      pointerId: number;
      localPoints: Array<[number, number, number]>;
      flowPoints: BoardDrawingSample[];
      simulatePressure: boolean;
      zoom: number;
    };

export function BoardToolGestureLayer({
  activeTool,
  enabled,
  onCommitDrawing,
  onCommitFrame,
}: {
  activeTool: CanvasInteractionMode;
  enabled: boolean;
  onCommitDrawing: (
    samples: readonly BoardDrawingSample[],
    options: CreateBoardDrawingOptions,
  ) => void;
  onCommitFrame: (bounds: BoardRect) => void;
}) {
  const [gesture, setGesture] = useState<BoardToolGesture | null>(null);
  const gestureRef = useRef<BoardToolGesture | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const { getViewport, screenToFlowPosition } = useReactFlow();
  const active = enabled && (activeTool === "frame-create" || activeTool === "freehand");

  const cancelScheduledRender = useCallback(() => {
    if (animationFrameRef.current === null) return;
    window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  }, []);

  const publishGesture = useCallback(() => {
    const current = gestureRef.current;
    setGesture(current ? cloneBoardToolGesture(current) : null);
  }, []);

  const scheduleGestureRender = useCallback(() => {
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      publishGesture();
    });
  }, [publishGesture]);

  const clearGesture = useCallback(() => {
    gestureRef.current = null;
    cancelScheduledRender();
    setGesture(null);
  }, [cancelScheduledRender]);

  useEffect(() => {
    gestureRef.current = null;
    cancelScheduledRender();
    setGesture(null);
    return () => {
      gestureRef.current = null;
      cancelScheduledRender();
    };
  }, [activeTool, cancelScheduledRender, enabled]);

  if (!active) return null;

  const localPoint = (event: Pick<PointerEvent, "clientX" | "clientY">, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const flowPoint = (event: Pick<PointerEvent, "clientX" | "clientY">) => (
    screenToFlowPosition({ x: event.clientX, y: event.clientY })
  );
  const appendDrawingSample = (
    current: Extract<BoardToolGesture, { kind: "drawing" }>,
    event: Pick<PointerEvent, "clientX" | "clientY" | "pressure">,
    element: HTMLElement,
    force = false,
  ): boolean => {
    const local = localPoint(event, element);
    const flow = flowPoint(event);
    const pressure = normalizeBoardDrawingPressure(event.pressure, current.simulatePressure);
    return appendBoardDrawingGestureSample(current, { local, flow, pressure }, force);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const local = localPoint(event, event.currentTarget);
    const flow = flowPoint(event);
    if (activeTool === "frame-create") {
      gestureRef.current = {
        kind: "frame",
        pointerId: event.pointerId,
        startLocal: local,
        currentLocal: local,
        startFlow: flow,
        currentFlow: flow,
      };
      publishGesture();
      return;
    }
    const simulatePressure = boardDrawingUsesSimulatedPressure(event.pointerType);
    const pressure = normalizeBoardDrawingPressure(event.pressure, simulatePressure);
    gestureRef.current = {
      kind: "drawing",
      pointerId: event.pointerId,
      localPoints: [[local.x, local.y, pressure]],
      flowPoints: [{ ...flow, pressure }],
      simulatePressure,
      zoom: getViewport().zoom,
    };
    publishGesture();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (current.kind === "frame") {
      gestureRef.current = {
        ...current,
        currentLocal: localPoint(event, event.currentTarget),
        currentFlow: flowPoint(event),
      };
      scheduleGestureRender();
      return;
    }

    const nativeEvents = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
    let changed = false;
    for (const sample of nativeEvents) {
      changed = appendDrawingSample(current, sample, event.currentTarget) || changed;
    }
    if (changed) scheduleGestureRender();
  };

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gestureRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current.kind === "frame") {
      const end = flowPoint(event);
      const width = end.x - current.startFlow.x;
      const height = end.y - current.startFlow.y;
      clearGesture();
      if (Math.abs(width) < 8 || Math.abs(height) < 8) return;
      onCommitFrame({ x: current.startFlow.x, y: current.startFlow.y, width, height });
      return;
    }
    appendDrawingSample(current, event, event.currentTarget, true);
    const samples = [...current.flowPoints];
    const options = { simulatePressure: current.simulatePressure };
    clearGesture();
    onCommitDrawing(samples, options);
  };

  const frameRect = gesture?.kind === "frame"
    ? normalizedLocalRect(gesture.startLocal, gesture.currentLocal)
    : null;
  const draftOutline = gesture?.kind === "drawing"
    ? getStroke(gesture.localPoints, {
        size: boardDrawingDraftStrokeSize(gesture.zoom),
        thinning: 0.55,
        smoothing: 0.65,
        streamline: 0.55,
        simulatePressure: gesture.simulatePressure,
      })
    : [];

  return (
    <div
      className="absolute inset-0 z-20 touch-none"
      data-board-tool-gesture-layer={activeTool}
      onPointerCancel={(event) => {
        if (gestureRef.current?.pointerId !== event.pointerId) return;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        clearGesture();
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishGesture}
    >
      {frameRect && (
        <div
          className="pointer-events-none absolute border border-[#7467f6] bg-[#7467f6]/[0.06]"
          style={frameRect}
        />
      )}
      {draftOutline.length > 0 && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          <path d={freehandOutlinePath(draftOutline)} fill="#f1f3f4" />
        </svg>
      )}
    </div>
  );
}

function cloneBoardToolGesture(gesture: BoardToolGesture): BoardToolGesture {
  return gesture.kind === "frame"
    ? {
        ...gesture,
        startLocal: { ...gesture.startLocal },
        currentLocal: { ...gesture.currentLocal },
        startFlow: { ...gesture.startFlow },
        currentFlow: { ...gesture.currentFlow },
      }
    : {
        ...gesture,
        localPoints: gesture.localPoints.map(([x, y, pressure]) => [x, y, pressure]),
        flowPoints: gesture.flowPoints.map((point) => ({ ...point })),
      };
}

function normalizedLocalRect(
  start: { x: number; y: number },
  end: { x: number; y: number },
): CSSProperties {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function RightToolRail({
  activeTool,
  activePanel,
  activeRun,
  directEditAvailable,
  editable,
  onSelectTool,
  onSelectMoreTool,
}: {
  activeTool: CanvasInteractionMode;
  activePanel: CanvasPanel;
  activeRun: boolean;
  directEditAvailable: boolean;
  editable: boolean;
  onSelectTool: (tool: CanvasMainCommand) => void;
  onSelectMoreTool: (tool: CanvasMoreCommand) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <motion.nav
      animate={{ opacity: 1, scale: floatingToolScale, x: 0 }}
      aria-label="画布工具"
      className={cn(
        "workbench-tool-rail absolute right-[16px] top-1/2 z-40 flex w-[48px] -translate-y-1/2 flex-col items-center gap-[6px] rounded-full border border-white/[0.10] bg-[#1c1d20]/94 py-[7px] shadow-[0_24px_74px_-36px_rgba(0,0,0,0.95)] backdrop-blur-xl max-md:left-1/2 max-md:right-auto max-md:w-auto max-md:-translate-x-1/2 max-md:translate-y-0 max-md:flex-row max-md:px-[7px] max-md:py-[5px]",
        activePanel === null
          ? "max-md:bottom-[190px] max-md:top-auto"
          : "max-md:bottom-auto max-md:top-[76px]",
      )}
      data-right-tool-rail
      initial={{ opacity: 0, scale: 0.96, x: 10 }}
      transition={{ ...panelTransition, delay: 0.12, scale: floatingToolTransition }}
    >
      {toolItems.map((tool, index) => {
        const Icon = tool.icon;
        const isPanel = tool.id === "media" || tool.id === "design-system" || tool.id === "favourites";
        const isActive = isPanel ? activePanel === tool.id : activeTool === tool.id;
        const disabled = tool.id === "direct-edit"
          ? !editable || activeRun || !directEditAvailable
          : isPanel
            ? tool.id === "media" && (!editable || activeRun)
            : tool.id !== "select" && tool.id !== "pan" && (activeRun || !editable);
        return (
          <button
            aria-label={tool.label}
            aria-pressed={isActive}
            className={cn(
              "workbench-tool-button group/tool relative grid size-[36px] place-items-center rounded-full transition-colors hover:bg-[#3a393a]/45",
              isActive ? "text-[#202124]" : "text-[#d5d8de]",
            )}
            disabled={disabled}
            key={tool.id}
            onClick={() => onSelectTool(tool.id)}
            title={tool.label}
            type="button"
          >
            {isActive && (
              <motion.span
                className="workbench-tool-active absolute inset-0 rounded-full bg-[#f1f3f4]"
                layoutId="workbench-rail-active-tool"
                transition={{ duration: 0.18, ease: workbenchEase }}
              />
            )}
            {index === 4 && <span className="absolute -top-[4px] h-px w-[30px] bg-[#494454]/55" />}
            <Icon className="relative z-10 size-[19px]" />
            <span className="workbench-tool-tooltip pointer-events-none absolute right-[44px] top-1/2 flex h-[28px] -translate-y-1/2 items-center rounded-[7px] border border-white/[0.08] bg-[#1b1c1f]/96 px-[9px] text-[12px] font-medium text-[#f1f3f4] shadow-[0_12px_36px_-20px_rgba(0,0,0,0.95)] max-md:hidden">
              {tool.label}
            </span>
          </button>
        );
      })}
      <div className="relative mt-[2px] pt-[4px]">
        <span className="pointer-events-none absolute -top-[1px] h-px w-[30px] bg-[#494454]/55" />
        <button
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          aria-label="More tools"
          className={cn(
            "workbench-tool-button group/tool relative grid size-[36px] place-items-center rounded-full text-[#d5d8de] transition-colors hover:bg-[#3a393a]/45",
            moreOpen && "bg-[#3a393a]/60 text-[#f1f3f4]",
          )}
          onClick={() => setMoreOpen((open) => !open)}
          title="More tools"
          type="button"
        >
          <MoreHorizontalIcon className="size-[19px]" />
          <span className="workbench-tool-tooltip pointer-events-none absolute right-[44px] top-1/2 flex h-[28px] -translate-y-1/2 items-center rounded-[7px] border border-white/[0.08] bg-[#1b1c1f]/96 px-[9px] text-[12px] font-medium text-[#f1f3f4] shadow-[0_12px_36px_-20px_rgba(0,0,0,0.95)] max-md:hidden">More tools</span>
        </button>
        <AnimatePresence>
          {moreOpen && (
            <motion.div
              animate={{ opacity: 1, x: 0 }}
              className="absolute right-[46px] top-0 w-[154px] rounded-[12px] border border-white/[0.10] bg-[#1b1c1f]/98 p-[5px] shadow-[0_18px_54px_-24px_rgba(0,0,0,0.98)] backdrop-blur-xl max-md:bottom-[46px] max-md:right-0 max-md:top-auto"
              exit={{ opacity: 0, x: 4 }}
              initial={{ opacity: 0, x: 4 }}
              role="menu"
              transition={popoverTransition}
            >
              <button
                className="flex h-[34px] w-full items-center gap-[8px] rounded-[8px] px-[9px] text-[12px] font-semibold text-[#e5e7eb] hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!editable || activeRun}
                onClick={() => { setMoreOpen(false); onSelectMoreTool("frame-create"); }}
                role="menuitem"
                type="button"
              >
                <FrameIcon className="size-[15px]" />
                Frame / Create
              </button>
              <button
                className="flex h-[34px] w-full items-center gap-[8px] rounded-[8px] px-[9px] text-[12px] font-semibold text-[#e5e7eb] hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!editable || activeRun}
                onClick={() => { setMoreOpen(false); onSelectMoreTool("freehand"); }}
                role="menuitem"
                type="button"
              >
                <PencilIcon className="size-[15px]" />
                Freehand
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.nav>
  );
}

export function UtilityPill({
  canRedo,
  canUndo,
  onFitSelection,
  onRedo,
  onResetView,
  onToggleZoomMenu,
  onUndo,
  onZoomIn,
  onZoomOut,
  onZoomTo,
  zoomMenuOpen,
  zoomLabel,
}: {
  canRedo: boolean;
  canUndo: boolean;
  onRedo: () => void;
  onFitSelection: () => void;
  onResetView: () => void;
  onToggleZoomMenu: () => void;
  onUndo: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomTo: (zoom: number) => void;
  zoomMenuOpen: boolean;
  zoomLabel: string;
}) {
  return (
    <motion.div
      animate={{ opacity: 1, scale: floatingToolScale, y: 0 }}
      className={cn(
        "workbench-utility-bar absolute z-40 flex items-center gap-[8px]",
      )}
      data-utility-pill
      initial={{ opacity: 0, scale: 0.96, y: 14 }}
      transition={{ ...panelTransition, delay: 0.24, scale: floatingToolTransition }}
    >
      <div className="workbench-utility-shell flex h-[36px] items-center gap-[3px] rounded-full border border-white/[0.10] bg-[#1c1d20]/94 p-[3px] shadow-[0_18px_64px_-32px_rgba(0,0,0,0.95)] backdrop-blur-xl">
        <button
          className={cn(
            "grid size-[28px] place-items-center rounded-full hover:bg-[#3a393a]/30",
            canUndo ? "text-[#cfd3da]" : "cursor-not-allowed text-[#5f6368]",
          )}
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo"
          type="button"
        >
          <Undo2Icon className="size-[16px]" />
        </button>
        <button
          className={cn(
            "grid size-[28px] place-items-center rounded-full hover:bg-[#3a393a]/30",
            canRedo ? "text-[#cfd3da]" : "cursor-not-allowed text-[#5f6368]",
          )}
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo"
          type="button"
        >
          <Redo2Icon className="size-[16px]" />
        </button>
      </div>
      <div className="relative">
        <button
          aria-expanded={zoomMenuOpen}
          aria-haspopup="menu"
          className={cn(
            "workbench-zoom-trigger h-[38px] rounded-full border px-[18px] text-[16px] font-semibold text-[#f1f3f4] shadow-[0_18px_64px_-32px_rgba(0,0,0,0.95)] backdrop-blur-xl transition-colors hover:bg-[#2b2c30]/90 max-sm:min-w-[58px] max-sm:px-[12px]",
            zoomMenuOpen ? "border-white/[0.16] bg-[#2a2b2f]/96" : "border-white/[0.10] bg-[#1c1d20]/94",
          )}
          onClick={onToggleZoomMenu}
          type="button"
        >
          {zoomLabel}
        </button>
        <AnimatePresence>
          {zoomMenuOpen && (
          <motion.div
            animate={{ opacity: 1, y: 0 }}
            className="workbench-zoom-menu absolute bottom-[56px] right-0 w-[236px] overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#18191b]/94 p-[7px] text-[#e8eaed] shadow-[0_24px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
            exit={{ opacity: 0, y: 4 }}
            initial={{ opacity: 0, y: 4 }}
            role="menu"
            transition={popoverTransition}
          >
            <ZoomCommandItem
              ariaKeyshortcuts="Mod+"
              label="Zoom in"
              onClick={onZoomIn}
              shortcut="Mod +"
            />
            <ZoomCommandItem
              ariaKeyshortcuts="Mod-"
              label="Zoom out"
              onClick={onZoomOut}
              shortcut="Mod -"
            />
            <ZoomCommandItem
              ariaKeyshortcuts="Shift+0"
              label="Zoom to 100%"
              onClick={() => onZoomTo(1)}
              shortcut="Shift + 0"
            />
            <ZoomCommandItem
              ariaKeyshortcuts="Shift+1"
              label="Zoom to Fit"
              onClick={onResetView}
              shortcut="Shift + 1"
            />
            <ZoomCommandItem
              ariaKeyshortcuts="Shift+2"
              label="Zoom to Selection"
              onClick={onFitSelection}
              shortcut="Shift + 2"
            />
            <div className="my-[6px] h-px bg-white/[0.08]" />
            <div aria-label="常用比例" className="px-[12px] pb-[3px] pt-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] text-[#858b94]" role="group">
              Common scale
            </div>
            <div className="grid grid-cols-3 gap-[3px]" role="group">
              {[10, 28, 57, 63, 93, 100].map((zoomPercent) => (
                <button
                  aria-label={`${zoomPercent}%`}
                  className={cn(
                    "workbench-zoom-item flex h-[34px] items-center justify-center rounded-[9px] px-[8px] text-[12px] font-semibold hover:bg-white/[0.06]",
                    zoomLabel === `${zoomPercent}%` && "is-selected",
                  )}
                  key={zoomPercent}
                  onClick={() => onZoomTo(zoomPercent / 100)}
                  role="menuitem"
                  type="button"
                >
                  {zoomPercent}%
                  {zoomLabel === `${zoomPercent}%` && <CheckCircle2Icon className="ml-[4px] size-[13px] text-[#d8dce2]" />}
                </button>
              ))}
            </div>
          </motion.div>
          )}
        </AnimatePresence>
      </div>
      <button
        aria-label="打开帮助"
        className="workbench-chrome-button grid size-[38px] place-items-center rounded-full border border-white/[0.10] bg-[#1c1d20]/94 text-[#f1f3f4] shadow-[0_18px_64px_-32px_rgba(0,0,0,0.95)] backdrop-blur-xl hover:bg-[#2b2c30]/90"
        onClick={() => openWorkbenchKnowledgePage()}
        type="button"
      >
        <HelpCircleIcon className="size-[17px]" />
      </button>
    </motion.div>
  );
}

function ZoomCommandItem({
  ariaKeyshortcuts,
  label,
  onClick,
  shortcut,
}: {
  ariaKeyshortcuts: string;
  label: string;
  onClick: () => void;
  shortcut: string;
}) {
  return (
    <button
      aria-keyshortcuts={ariaKeyshortcuts}
      className="flex h-[38px] w-full items-center justify-between rounded-[10px] px-[12px] text-left text-[13px] font-semibold hover:bg-white/[0.06]"
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      <span>{label}</span>
      <span aria-hidden="true" className="text-[11px] font-medium text-[#858b94]">{shortcut}</span>
    </button>
  );
}
