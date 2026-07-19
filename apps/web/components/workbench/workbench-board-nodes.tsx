"use client";

import {
  type Node,
  type NodeProps,
  NodeResizer,
} from "@xyflow/react";
import {
  ArrowUpIcon,
  FileTextIcon,
  FrameIcon,
  HistoryIcon,
  ImageIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { getStroke } from "perfect-freehand";
import { createContext, type ReactNode, useContext } from "react";
import type {
  BoardNodeData,
  PrdDocument,
  PrototypeDocument,
} from "@workbench/workbench-contracts";
import { cn } from "@/lib/utils";
import {
  isWorkbenchNodeResizeVisible,
  type WorkbenchProjectMode,
  type WorkbenchProjectPhase,
} from "@/lib/workbench/features";
import {
  WorkbenchArtifactContent,
  type WorkbenchArtifactReference,
} from "./workbench-artifact-content";
import { WorkbenchArtifactPreferenceActions } from "./workbench-artifact-preference-actions";
import {
  WorkbenchArtifactFallback,
  WorkbenchArtifactSkeleton,
} from "./workbench-artifact-fallback";
import {
  panelTransition,
  workbenchEase,
} from "./workbench-motion";
import {
  MiniWorkbenchPreview,
  useWorkbenchRunPreview,
} from "./workbench-run-preview";
import { DottedBackdrop } from "./workbench-surface-primitives";

type ProjectMode = WorkbenchProjectMode;
type Phase = WorkbenchProjectPhase;

type WorkbenchArtifactVersionContextValue = {
  onOpen: (reference: WorkbenchArtifactReference) => void;
};

type WorkbenchPrototypeEditContextValue = {
  busy: boolean;
  enabled: boolean;
  onDocumentCommit: (
    reference: WorkbenchArtifactReference,
    document: PrototypeDocument,
  ) => Promise<void>;
};

type WorkbenchPrdEditContextValue = {
  busy: boolean;
  enabled: boolean;
  onDocumentCommit: (
    reference: WorkbenchArtifactReference,
    document: PrdDocument,
  ) => Promise<void>;
};

const WorkbenchCanvasEditContext = createContext(false);
const WorkbenchScreenContextTitleReplacementContext = createContext(false);
const WorkbenchArtifactVersionContext = createContext<WorkbenchArtifactVersionContextValue>({
  onOpen: () => undefined,
});
const WorkbenchPrototypeEditContext = createContext<WorkbenchPrototypeEditContextValue>({
  busy: false,
  enabled: false,
  onDocumentCommit: async () => undefined,
});
const WorkbenchPrdEditContext = createContext<WorkbenchPrdEditContextValue>({
  busy: false,
  enabled: false,
  onDocumentCommit: async () => undefined,
});

export type ArtboardData = {
  mode: ProjectMode;
  phase: Phase;
  title: string;
};

export type BoardTileData = {
  accent: string;
  kind: "screen" | "image" | "doc" | "palette" | "wire";
  subtitle: string;
  title: string;
};

export type GeneratedScreenData = {
  artifact?: WorkbenchArtifactReference;
  index: number;
  phase: Phase;
  suppressEntrance?: boolean;
  title: string;
};

export type DocumentCanvasData = {
  artifact?: WorkbenchArtifactReference;
  phase: Phase;
  suppressEntrance?: boolean;
  title: string;
};

export type GeneratedStyleBoardData = {
  title: string;
};

type BoardFrameData = Extract<BoardNodeData, { nodeType: "frame" }>;
type BoardDrawingData = Extract<BoardNodeData, { nodeType: "drawing" }>;

export type OverviewArtifactData = {
  artifact?: WorkbenchArtifactReference;
  compact?: boolean;
  kind: "image" | "screen" | "style" | "code" | "doc";
  pendingIndex?: number;
  pendingLabel?: "生成上下文" | "生成资源" | "生成样式" | "生成代码" | "生成文档";
  phase?: Phase;
  title: string;
};

export type ArtboardNode = Node<ArtboardData, "workbenchArtboard">;
export type BoardTileNode = Node<BoardTileData, "workbenchTile">;
export type GeneratedScreenNode = Node<GeneratedScreenData, "generatedScreen">;
export type DocumentCanvasNode = Node<DocumentCanvasData, "documentCanvas">;
export type GeneratedStyleBoardNode = Node<GeneratedStyleBoardData, "generatedStyleBoard">;
export type OverviewArtifactNode = Node<OverviewArtifactData, "overviewArtifact">;
export type BoardFrameNode = Node<BoardFrameData, "frame">;
export type BoardDrawingNode = Node<BoardDrawingData, "drawing">;
export type WorkbenchNode =
  | ArtboardNode
  | BoardTileNode
  | GeneratedScreenNode
  | DocumentCanvasNode
  | GeneratedStyleBoardNode
  | OverviewArtifactNode
  | BoardFrameNode
  | BoardDrawingNode;

export function WorkbenchBoardNodeProvider({
  artifactVersions,
  canResizeNodes,
  children,
  overlay,
  prdEditor,
  prototypeEditor,
  screenContextToolbarReplacesTitle = false,
}: {
  artifactVersions: WorkbenchArtifactVersionContextValue;
  canResizeNodes: boolean;
  children: ReactNode;
  overlay?: ReactNode;
  prdEditor: WorkbenchPrdEditContextValue;
  prototypeEditor: WorkbenchPrototypeEditContextValue;
  screenContextToolbarReplacesTitle?: boolean;
}) {
  return (
    <WorkbenchPrototypeEditContext.Provider value={prototypeEditor}>
      <WorkbenchPrdEditContext.Provider value={prdEditor}>
        <WorkbenchCanvasEditContext.Provider value={canResizeNodes}>
          <WorkbenchScreenContextTitleReplacementContext.Provider value={screenContextToolbarReplacesTitle}>
            <WorkbenchArtifactVersionContext.Provider value={artifactVersions}>
              {children}
            </WorkbenchArtifactVersionContext.Provider>
          </WorkbenchScreenContextTitleReplacementContext.Provider>
          {overlay}
        </WorkbenchCanvasEditContext.Provider>
      </WorkbenchPrdEditContext.Provider>
    </WorkbenchPrototypeEditContext.Provider>
  );
}

export const artboardNodeTypes = {
  drawing: WorkbenchBoardDrawingNode,
  frame: WorkbenchBoardFrameNode,
  documentCanvas: DocumentCanvasNode,
  generatedScreen: GeneratedScreenNode,
  generatedStyleBoard: GeneratedStyleBoardNode,
  overviewArtifact: OverviewArtifactNode,
  workbenchArtboard: WorkbenchArtboardNode,
  workbenchTile: WorkbenchBoardTileNode,
};

function generationLayerMotion(phase: Phase) {
  if (phase === "generating") {
    return {
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      initial: { opacity: 1 },
      transition: { duration: 0.16, ease: workbenchEase },
    };
  }

  if (phase === "refining") {
    return {
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      initial: { opacity: 1 },
      transition: { duration: 0.16, ease: workbenchEase },
    };
  }

  if (phase === "complete") {
    return {
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      initial: { opacity: 1 },
      transition: { duration: 0.18, ease: workbenchEase },
    };
  }

  return {
    animate: { opacity: 1 },
    exit: { opacity: 0 },
    initial: { opacity: 0 },
    transition: panelTransition,
  };
}

function GeneratedStyleBoardNode({ data }: NodeProps<GeneratedStyleBoardNode>) {
  return (
    <section
      aria-label={data.title}
      className="pointer-events-none grid h-full w-full grid-cols-2 gap-[10px] bg-[#0f1117]/20"
    >
      {[
        { label: "Aa", sub: "Plus Jakarta Sans", type: "type" },
        { label: "Primary", sub: "Secondary", type: "buttons" },
        { label: "Aa", sub: "Regular", type: "type" },
        { label: "Search", sub: "Input", type: "input" },
        { label: "Aa", sub: "Bold", type: "type" },
        { label: "Home", sub: "Navigation", type: "nav" },
        { label: "Aa", sub: "Display", type: "type" },
        { label: "Label", sub: "Controls", type: "controls" },
      ].map((item) => (
        <div
          className="h-[108px] overflow-hidden rounded-[8px] border border-white/[0.06] bg-[#15181c]/94 p-[14px] shadow-[0_18px_60px_-34px_rgba(0,0,0,0.95)]"
          key={`${item.label}-${item.sub}`}
        >
          {item.type === "type" ? (
            <>
              <div className="text-[72px] font-semibold leading-[58px] text-[#e8ecff]">{item.label}</div>
              <div className="mt-[9px] h-[3px] w-[88px] rounded-full bg-[#8da3ff]" />
              <div className="mt-[8px] text-[9px] text-[#8f949c]">{item.sub}</div>
            </>
          ) : item.type === "buttons" ? (
            <div className="grid grid-cols-2 gap-[8px] text-center text-[10px] font-semibold">
              {["Primary", "Secondary", "Inverted", "Outlined"].map((button, index) => (
                <span
                  className={cn(
                    "h-[24px] rounded-[4px] border pt-[6px]",
                    index === 0 ? "border-[#9dafef] bg-[#9dafef] text-[#101827]" : index === 1 ? "border-white/[0.08] bg-[#242832] text-[#d8dce2]" : index === 2 ? "border-white/[0.08] bg-[#d8dce2] text-[#101827]" : "border-[#8f949c] bg-transparent text-[#d8dce2]",
                  )}
                  key={button}
                >
                  {button}
                </span>
              ))}
            </div>
          ) : item.type === "input" ? (
            <div className="mt-[18px] h-[30px] rounded-[3px] border border-white/[0.08] bg-[#1d2026] px-[10px] pt-[8px] text-[10px] text-[#8f949c] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              Search
            </div>
          ) : item.type === "nav" ? (
            <div className="mt-[32px] flex h-[34px] items-center justify-around rounded-[7px] bg-[#1d2026] text-[#9aa0a6] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <span className="grid size-[22px] place-items-center rounded-full bg-[#8da3ff] text-[#111827]">⌂</span>
              <SearchIcon className="size-[14px]" />
              <span className="text-[14px]">♙</span>
            </div>
          ) : (
            <div className="mt-[24px] flex items-center gap-[9px]">
              <span className="grid size-[28px] place-items-center rounded-[4px] bg-[#b94b1f] text-white">↗</span>
              <span className="rounded-[4px] bg-[#2f6df6] px-[14px] py-[7px] text-[10px] text-white">Label</span>
              {["#8da3ff", "#f6bd45", "#ef7d6f", "#c24a55"].map((color) => (
                <span className="size-[20px] rounded-full border border-white/[0.08]" key={color} style={{ backgroundColor: color }} />
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function OverviewArtifactNode({ data }: NodeProps<OverviewArtifactNode>) {
  const phase = data.phase ?? "generating";
  return (
    <section className="pointer-events-none h-full w-full overflow-visible text-[#d8dce2]">
      <div className="mb-[7px] flex h-[18px] items-center gap-[6px] text-[15px] font-medium leading-none">
        {data.kind === "image" ? <ImageIcon className="size-[15px]" /> : data.kind === "doc" ? <FileTextIcon className="size-[15px]" /> : <FrameIcon className="size-[15px]" />}
        <span className="max-w-full truncate">{data.title}</span>
      </div>
      <div className="relative h-[calc(100%-25px)] w-full overflow-hidden rounded-[4px] border border-white/[0.12] bg-[#0f1012] shadow-[0_18px_60px_-38px_rgba(0,0,0,0.95)]">
        {data.artifact ? (
          <WorkbenchArtifactContent reference={data.artifact} />
        ) : phase === "complete" ? (
          <WorkbenchArtifactFallback
            phase="complete"
            title={data.title}
            variant="prototype"
          />
        ) : (
          <>
            {data.kind === "image" && <OverviewImagePreview />}
            {data.kind === "screen" && <OverviewScreenPreview compact={data.compact === true} />}
            {data.kind === "style" && <OverviewStylePreview />}
            {data.kind === "code" && <OverviewCodePreview />}
            {data.kind === "doc" && <OverviewDocPreview />}
          </>
        )}
      </div>
    </section>
  );
}

function OverviewImagePreview() {
  return (
    <div className="absolute inset-0 bg-[#07080d]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(94,92,230,0.48),transparent_30%),radial-gradient(circle_at_75%_65%,rgba(45,212,191,0.28),transparent_32%)]" />
      <div className="absolute bottom-[18px] left-[18px] h-[36px] w-[120px] rounded-[6px] bg-white/[0.08]" />
      <div className="absolute right-[20px] top-[18px] h-[54px] w-[76px] rounded-[8px] bg-white/[0.10]" />
    </div>
  );
}

function OverviewScreenPreview({ compact }: { compact: boolean }) {
  return (
    <div className={cn("absolute inset-0 bg-[#111214] p-[12px]", compact && "bg-[#f2f4f5]")}>
      <div className={cn("mb-[10px] h-[18px] rounded-[4px]", compact ? "bg-[#0d5fd7]" : "bg-white/[0.10]")} />
      <div className="grid h-[calc(100%-28px)] grid-cols-[0.85fr_1fr] gap-[10px]">
        <div className={cn("rounded-[5px]", compact ? "bg-white" : "bg-[#1d1f24]")} />
        <div className="space-y-[8px]">
          {[0, 1, 2, 3].map((item) => (
            <span className={cn("block h-[14px] rounded-full", compact ? "bg-[#d7dce2]" : "bg-white/[0.12]")} key={item} />
          ))}
        </div>
      </div>
    </div>
  );
}

function OverviewStylePreview() {
  return (
    <div className="absolute inset-0 grid grid-cols-[0.48fr_1fr] gap-[8px] bg-[#111214] p-[10px]">
      <div className="space-y-[5px]">
        {["#1f1f25", "#4b2f91", "#3556c8", "#d8dce2"].map((color) => (
          <span className="block h-[28px] rounded-[3px]" key={color} style={{ backgroundColor: color }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-[6px]">
        {["Aa", "Aa", "Aa", "••"].map((label, index) => (
          <span className="grid place-items-center rounded-[4px] bg-[#1c1e22] text-[24px] font-semibold text-[#d8dce2]" key={`${label}-${index}`}>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function OverviewCodePreview() {
  return (
    <div className="absolute inset-0 bg-[#0c0d10] p-[12px]">
      <div className="mb-[12px] flex gap-[6px]">
        <span className="size-[7px] rounded-full bg-[#7467f6]" />
        <span className="size-[7px] rounded-full bg-[#4c89ff]" />
        <span className="size-[7px] rounded-full bg-[#d8dce2]" />
      </div>
      <div className="space-y-[7px]">
        {[92, 68, 118, 84, 132, 74, 108, 96, 126].map((width, index) => (
          <span
            className={cn("block h-[5px] rounded-full", index % 3 === 0 ? "bg-[#7467f6]" : "bg-white/[0.20]")}
            key={`${width}-${index}`}
            style={{ width }}
          />
        ))}
      </div>
    </div>
  );
}

function OverviewDocPreview() {
  return (
    <div className="absolute inset-0 bg-[#1b1c1f] p-[12px]">
      <div className="mb-[10px] h-[12px] w-[82px] rounded-full bg-white/[0.45]" />
      <div className="space-y-[7px]">
        {[140, 118, 152, 94, 136, 122].map((width, index) => (
          <span className="block h-[5px] rounded-full bg-white/[0.22]" key={`${width}-${index}`} style={{ width }} />
        ))}
      </div>
    </div>
  );
}

function WorkbenchBoardFrameNode({ data, selected }: NodeProps<BoardFrameNode>) {
  const canResizeNodes = useContext(WorkbenchCanvasEditContext);
  return (
    <section
      className="relative h-full w-full overflow-visible border bg-white/[0.015]"
      style={{
        backgroundColor: data.fill ?? undefined,
        borderColor: selected ? "#7467f6" : data.stroke,
      }}
    >
      <NodeResizer
        color="#7467f6"
        handleClassName="!size-[8px] !border !border-[#7467f6] !bg-[#dfe2ff]"
        isVisible={isWorkbenchNodeResizeVisible(canResizeNodes, selected)}
        lineClassName="!border-[#7467f6]"
        minHeight={60}
        minWidth={80}
      />
      <div className="pointer-events-none absolute left-0 top-[-25px] flex items-center gap-[6px] text-[13px] font-medium leading-none text-[#d8dce2]">
        <FrameIcon className="size-[13px]" />
        <span className="max-w-[220px] truncate">{data.title}</span>
      </div>
    </section>
  );
}

function WorkbenchBoardDrawingNode({ data, selected }: NodeProps<BoardDrawingNode>) {
  const canResizeNodes = useContext(WorkbenchCanvasEditContext);
  const outline = getStroke(data.stroke.points, {
    size: data.stroke.size,
    thinning: data.stroke.thinning,
    smoothing: data.stroke.smoothing,
    streamline: data.stroke.streamline,
    simulatePressure: data.stroke.simulatePressure,
  });
  return (
    <section className="relative h-full w-full overflow-visible">
      <NodeResizer
        color="#7467f6"
        handleClassName="!size-[8px] !border !border-[#7467f6] !bg-[#dfe2ff]"
        isVisible={isWorkbenchNodeResizeVisible(canResizeNodes, selected)}
        lineClassName="!border-[#7467f6]"
        minHeight={8}
        minWidth={8}
      />
      <svg
        aria-label={data.title}
        className="pointer-events-none h-full w-full overflow-visible"
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${data.stroke.intrinsicSize.width} ${data.stroke.intrinsicSize.height}`}
      >
        <path d={freehandOutlinePath(outline)} fill={data.stroke.color} />
      </svg>
    </section>
  );
}

export function freehandOutlinePath(points: number[][]): string {
  if (points.length < 2) return "";
  const first = points[0]!;
  const last = points.at(-1)!;
  const commands = points.slice(1, -1).map((point, index) => {
    const next = points[index + 2]!;
    return `Q ${point[0]} ${point[1]} ${(point[0] + next[0]) / 2} ${(point[1] + next[1]) / 2}`;
  });
  return [`M ${first[0]} ${first[1]}`, ...commands, `Q ${last[0]} ${last[1]} ${first[0]} ${first[1]}`, "Z"].join(" ");
}

function WorkbenchBoardTileNode({ data, selected }: NodeProps<BoardTileNode>) {
  const canResizeNodes = useContext(WorkbenchCanvasEditContext);
  return (
    <section
      className={cn(
        "group relative h-full w-full overflow-visible transition",
        selected && "z-20",
      )}
    >
      <NodeResizer
        color="#7467f6"
        handleClassName="!size-[8px] !border !border-[#7467f6] !bg-[#dfe2ff]"
        isVisible={isWorkbenchNodeResizeVisible(canResizeNodes, selected)}
        lineClassName="!border-[#7467f6]"
        minHeight={150}
        minWidth={240}
      />
      {data.kind === "image" ? (
        <div className="relative h-full w-full overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#171819] shadow-[0_24px_90px_-44px_rgba(0,0,0,0.95)]">
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(16,17,18,0.96)_0%,rgba(33,36,38,0.88)_48%,rgba(44,48,47,0.82)_100%)]" />
          <div className="absolute inset-y-0 left-[46%] w-[120px] bg-[linear-gradient(90deg,transparent,rgba(186,206,197,0.13),transparent)] blur-[12px]" />
        </div>
      ) : (
        <WorkbenchReferenceTile />
      )}
    </section>
  );
}

function WorkbenchReferenceTile() {
  return (
    <div className="relative h-full w-full overflow-hidden rounded-[18px] border border-white/[0.10] bg-[#111214] p-[26px] shadow-[0_24px_90px_-44px_rgba(0,0,0,0.95)]">
      <DottedBackdrop />
      <div className="relative grid h-full grid-cols-[0.88fr_1.08fr_0.86fr] gap-[22px]">
        <section className="overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#191a1d]/94 shadow-[0_22px_58px_-40px_rgba(0,0,0,0.9)]">
          <div className="flex h-[72px] items-center justify-between border-b border-white/[0.06] px-[24px]">
            <div>
              <div className="mb-[7px] h-[9px] w-[132px] rounded-full bg-[#f1f3f4]" />
              <div className="h-[6px] w-[82px] rounded-full bg-[#9aa0a6]" />
            </div>
            <span className="grid size-[34px] place-items-center rounded-full bg-[#536a74] text-[14px] font-semibold text-white">L</span>
          </div>
          <div className="space-y-[18px] p-[24px]">
            <div className="rounded-[18px] border border-white/[0.08] bg-[#232428] p-[18px]">
              <div className="mb-[14px] flex items-center gap-[10px]">
                <span className="size-[14px] rounded-full bg-[#d0bcff]" />
                <span className="h-[10px] w-[156px] rounded-full bg-white/72" />
              </div>
              <div className="space-y-[10px]">
                <span className="block h-[7px] w-[330px] rounded-full bg-white/20" />
                <span className="block h-[7px] w-[260px] rounded-full bg-white/14" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-[14px]">
              {["#d0bcff", "#63e6f2", "#f8fafc", "#2b2d31"].map((color) => (
                <div className="h-[104px] rounded-[18px] border border-white/[0.08] p-[14px]" key={color} style={{ backgroundColor: color }}>
                  <span className="block h-[8px] w-[88px] rounded-full bg-black/28" />
                </div>
              ))}
            </div>
            <div className="rounded-[18px] border border-white/[0.08] bg-[#232428] p-[18px]">
              <div className="mb-[14px] h-[9px] w-[118px] rounded-full bg-white/68" />
              <div className="grid grid-cols-3 gap-[10px]">
                {[0, 1, 2].map((item, index) => (
                  <span
                    className={cn(
                      "block h-[38px] rounded-full",
                      index === 0 ? "bg-[#f1f3f4]" : "bg-white/[0.08]",
                    )}
                    key={item}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="grid grid-rows-[0.9fr_1.1fr] gap-[22px]">
          <div className="overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#eef4f1] p-[24px] text-[#111827] shadow-[0_22px_58px_-40px_rgba(0,0,0,0.9)]">
            <div className="mb-[22px] flex items-center justify-between">
              <div>
                <div className="mb-[8px] h-[12px] w-[190px] rounded-full bg-[#111827]" />
                <div className="h-[7px] w-[126px] rounded-full bg-[#64748b]" />
              </div>
              <span className="flex h-[34px] w-[112px] items-center gap-[8px] rounded-full bg-[#111827] px-[12px]">
                <span className="size-[10px] rounded-full bg-[#22c55e]" />
                <span className="h-[7px] flex-1 rounded-full bg-white/68" />
              </span>
            </div>
            <div className="grid h-[210px] grid-cols-[0.86fr_1fr] gap-[18px]">
              <div className="rounded-[24px] bg-[#111827] p-[16px] text-white">
                <span className="mb-[16px] block h-[9px] w-[118px] rounded-full bg-white/80" />
                <div className="grid grid-cols-2 gap-[10px]">
                  {["#d0bcff", "#63e6f2", "#f97316", "#22c55e"].map((color) => (
                    <span className="h-[62px] rounded-[16px]" key={color} style={{ backgroundColor: color }} />
                  ))}
                </div>
              </div>
              <div className="rounded-[24px] bg-white p-[18px] shadow-inner">
                <div className="mb-[16px] h-[10px] w-[168px] rounded-full bg-[#111827]" />
                <div className="space-y-[10px]">
                  <span className="block h-[8px] w-[230px] rounded-full bg-[#94a3b8]" />
                  <span className="block h-[8px] w-[200px] rounded-full bg-[#cbd5e1]" />
                  <span className="block h-[8px] w-[252px] rounded-full bg-[#cbd5e1]" />
                </div>
                <div className="mt-[22px] grid grid-cols-2 gap-[12px]">
                  <span className="h-[42px] rounded-full bg-[#111827]" />
                  <span className="h-[42px] rounded-full bg-[#e2e8f0]" />
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#17181b] p-[24px] shadow-[0_22px_58px_-40px_rgba(0,0,0,0.9)]">
            <div className="mb-[18px] flex items-center justify-between">
              <div className="h-[12px] w-[184px] rounded-full bg-white/80" />
              <div className="flex gap-[8px]">
                <span className="size-[24px] rounded-full bg-[#d0bcff]" />
                <span className="size-[24px] rounded-full bg-[#63e6f2]" />
              </div>
            </div>
            <div className="grid h-[274px] grid-cols-3 gap-[16px]">
              {[
                ["#f8fafc", "#111827"],
                ["#d0bcff", "#281d36"],
                ["#111827", "#f8fafc"],
              ].map(([bg, fg], index) => (
                <div className="rounded-[24px] p-[18px]" key={`${bg}-${fg}`} style={{ backgroundColor: bg, color: fg }}>
                  <div className="mb-[18px] h-[12px] w-[96px] rounded-full" style={{ backgroundColor: fg }} />
                  <div className="mb-[28px] text-[62px] font-semibold leading-none">Aa</div>
                  <div className="space-y-[9px]">
                    <span className="block h-[7px] w-[132px] rounded-full opacity-55" style={{ backgroundColor: fg }} />
                    <span className="block h-[7px] w-[92px] rounded-full opacity-35" style={{ backgroundColor: fg }} />
                  </div>
                  {index === 1 && <div className="mt-[24px] h-[42px] rounded-full bg-white/82" />}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid grid-rows-[1fr_0.72fr] gap-[22px]">
          <div className="overflow-hidden rounded-[28px] border border-white/[0.08] bg-[#202124] p-[22px]">
            <div className="mb-[18px] flex h-[46px] items-center gap-[12px] rounded-full border border-white/[0.10] bg-[#2c2d30] px-[16px]">
              <PlusIcon className="size-[18px] text-[#d8dce2]" />
              <span className="h-[8px] flex-1 rounded-full bg-white/22" />
              <ArrowUpIcon className="size-[18px] text-[#d0bcff]" />
            </div>
            <div className="space-y-[14px]">
              {[0, 1, 2, 3].map((item, index) => (
                <div className="rounded-[18px] border border-white/[0.08] bg-white/[0.04] p-[16px]" key={item}>
                  <div className="mb-[10px] flex items-center gap-[10px]">
                    <span className={cn("size-[10px] rounded-full", index === 0 ? "bg-[#d0bcff]" : "bg-[#5f6368]")} />
                    <span className="h-[10px] w-[160px] rounded-full bg-[#f1f3f4]/72" />
                  </div>
                  <span className="block h-[7px] w-[260px] rounded-full bg-white/18" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-[28px] border border-white/[0.08] bg-[#101112] p-[22px]">
            <div className="mb-[18px] h-[10px] w-[146px] rounded-full bg-white/78" />
            <div className="grid grid-cols-4 gap-[12px]">
              {["#536a74", "#d0bcff", "#63e6f2", "#f1f3f4", "#202124", "#3f4247", "#f97316", "#22c55e"].map((color) => (
                <span className="h-[58px] rounded-[16px] border border-white/[0.08]" key={color} style={{ backgroundColor: color }} />
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function WorkbenchArtboardNode({ data, selected }: NodeProps<ArtboardNode>) {
  const canResizeNodes = useContext(WorkbenchCanvasEditContext);
  const runPreview = useWorkbenchRunPreview();
  const projectTitle = runPreview?.projectTitle.trim() || data.title;
  return (
    <section className="relative h-full w-full bg-[#141516] shadow-2xl">
      <NodeResizer
        color="#7467f6"
        handleClassName="!size-[8px] !border !border-[#7467f6] !bg-[#dfe2ff]"
        isVisible={isWorkbenchNodeResizeVisible(canResizeNodes, selected)}
        lineClassName="!border-[#7467f6]"
        minHeight={420}
        minWidth={640}
      />
      <div className="pointer-events-none absolute inset-0 z-20 border-[2px] border-[#7467f6]" />
      <div className="absolute left-0 top-[-28px] z-30 flex items-center gap-[8px] text-[14px] font-medium leading-none text-[#f1f3f4]">
        <FrameIcon className="size-[14px]" />
        {projectTitle}
      </div>
      <div className="relative h-full w-full overflow-visible bg-[#111214]">
        <MiniWorkbenchPreview phase={data.phase} />
      </div>
    </section>
  );
}

function DocumentCanvasNode({ data, selected }: NodeProps<DocumentCanvasNode>) {
  const canResizeNodes = useContext(WorkbenchCanvasEditContext);
  const artifactVersions = useContext(WorkbenchArtifactVersionContext);
  const prdEditor = useContext(WorkbenchPrdEditContext);
  const isLoading = data.phase === "generating" || data.phase === "refining";
  const editing = Boolean(selected && data.artifact && prdEditor.enabled && !isLoading);

  return (
    <section className={cn(
      "relative h-full w-full bg-[#1d1d1f] text-[#f1f3f4] shadow-[0_24px_90px_-44px_rgba(0,0,0,0.95)]",
      editing && "nodrag nopan",
    )}>
      <NodeResizer
        color="#7467f6"
        handleClassName="!size-[8px] !border !border-[#7467f6] !bg-[#dfe2ff]"
        isVisible={isWorkbenchNodeResizeVisible(canResizeNodes, selected)}
        lineClassName="!border-[#7467f6]"
        minHeight={520}
        minWidth={520}
      />
      {(selected || isLoading) && <div className="pointer-events-none absolute inset-0 z-20 border-[2px] border-[#7467f6]" />}
      <div className="absolute left-0 top-[-31px] z-30 flex items-center gap-[7px] text-[14px] font-medium leading-none text-[#f1f3f4]">
        <FileTextIcon className="size-[14px]" />
        {data.title}
      </div>
      {selected && data.artifact && (
        <div className="nodrag nopan absolute right-0 top-[-31px] z-30 flex h-[24px] items-center gap-[10px] text-[#d8dce2]">
          <button
            aria-label="查看版本记录"
            className="grid size-[22px] place-items-center rounded-[4px] hover:bg-white/[0.08] hover:text-white"
            onClick={(event) => {
              event.stopPropagation();
              artifactVersions.onOpen(data.artifact!);
            }}
            title="版本记录"
            type="button"
          >
            <HistoryIcon className="size-[14px]" />
          </button>
          {data.artifact.screenId && (
            <WorkbenchArtifactPreferenceActions
              artifactVersionId={data.artifact.artifactVersionId}
              screenId={data.artifact.screenId}
            />
          )}
        </div>
      )}
      <div className="absolute inset-0 overflow-hidden bg-[#1d1d1f]">
        <AnimatePresence initial={false} mode="wait">
          {isLoading && !data.artifact ? (
            <motion.div
              animate={{ opacity: 1 }}
              className="absolute inset-0"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              key="document-loading"
              transition={{ duration: 0.22, ease: workbenchEase }}
            >
              <WorkbenchArtifactFallback
                phase={data.phase === "refining" ? "refining" : "generating"}
                title={data.title}
                variant="document"
              />
              <GeneratingWash mode="document" />
            </motion.div>
          ) : (
            <motion.div
              animate={{ opacity: 1, y: 0 }}
              className={cn("absolute inset-0", !data.artifact && "px-[38px] py-[34px]")}
              initial={data.suppressEntrance ? false : { opacity: 0, y: 5 }}
              key="document-content"
              transition={data.suppressEntrance
                ? { duration: 0 }
                : { duration: 0.32, ease: workbenchEase }}
            >
              {data.artifact ? (
                <WorkbenchArtifactContent
                  editable={editing}
                  editingBusy={prdEditor.busy}
                  onPrdDocumentCommit={prdEditor.onDocumentCommit}
                  reference={data.artifact}
                />
              ) : (
                <WorkbenchArtifactFallback
                  phase="complete"
                  title={data.title}
                  variant="document"
                />
              )}
              {isLoading && <GeneratingWash mode="light" />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </section>
  );
}

function GeneratedScreenNode({ data, id, selected }: NodeProps<GeneratedScreenNode>) {
  const canResizeNodes = useContext(WorkbenchCanvasEditContext);
  const screenContextToolbarReplacesTitle = useContext(WorkbenchScreenContextTitleReplacementContext);
  const prototypeEditor = useContext(WorkbenchPrototypeEditContext);
  const isReady = data.phase === "complete";
  const isGenerating = data.phase === "generating";
  const isRefining = data.phase === "refining";
  const layerMotion = generationLayerMotion(data.phase);
  const editing = Boolean(selected && isReady && data.artifact && prototypeEditor.enabled);

  return (
    <section
      className="workbench-generated-node relative h-full w-full"
      data-canvas-artifact-id={data.artifact?.artifactId}
      data-canvas-artifact-version-id={data.artifact?.artifactVersionId}
      data-canvas-board-node-id={id}
      data-canvas-screen-id={data.artifact?.screenId}
      data-canvas-screen-node
      data-prototype-editing={editing ? "true" : undefined}
      data-generated-index={data.index}
      data-generated-phase={data.phase}
      data-generated-ready={isReady ? "true" : undefined}
      data-workbench-generated-node
      style={data.suppressEntrance ? { animation: "none" } : undefined}
    >
      <NodeResizer
        color="#7467f6"
        handleClassName="!size-[8px] !border !border-[#7467f6] !bg-[#dfe2ff]"
        isVisible={isWorkbenchNodeResizeVisible(canResizeNodes, selected, isReady)}
        lineClassName="!border-[#7467f6]"
        minHeight={520}
        minWidth={300}
      />
      <AnimatePresence>
        {selected && isReady && data.artifact && (
          <motion.div
            animate={{ opacity: 1 }}
            className="workbench-selection-glow pointer-events-none absolute inset-0 z-30 border-[2px] border-[#7467f6]"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.14, delay: isReady ? 0.10 : 0, ease: workbenchEase }}
          />
        )}
      </AnimatePresence>
      {(!selected || !isReady || !screenContextToolbarReplacesTitle) && (
        <div className="absolute left-0 top-[-31px] z-30 flex items-center gap-[7px] text-[14px] font-medium leading-none text-[#f1f3f4]">
          <FrameIcon className="size-[14px]" />
          <span className="max-w-[560px] truncate">
            {isReady
              ? data.title
              : data.phase === "refining" ? `正在细化：${data.title}` : `正在生成：${data.title}`}
          </span>
        </div>
      )}
      <div
        className={cn(
          "relative h-full w-full overflow-hidden shadow-[0_24px_90px_-44px_rgba(0,0,0,0.95)]",
          !isGenerating && "workbench-generation-surface",
          isRefining && "workbench-generation-surface--refining",
          isReady && "workbench-generation-surface--complete",
          isGenerating ? "bg-[#d2d0ca] text-[#171717]" : "bg-[#242629]",
        )}
      >
        {!isGenerating && (
          <>
            <div className="absolute inset-0 bg-[linear-gradient(100deg,#282b2d_0%,#34373a_42%,#2d3835_63%,#2b2d31_100%)]" />
            <div className="absolute inset-y-0 left-[50%] w-[100px] bg-[linear-gradient(90deg,transparent,rgba(190,213,204,0.12),transparent)] blur-[12px]" />
          </>
        )}
        <AnimatePresence initial={false} mode="sync">
          <motion.div
            animate={layerMotion.animate}
            className={cn("absolute inset-0", editing && "nodrag nopan")}
            exit={layerMotion.exit}
            initial={layerMotion.initial}
            key={`${data.phase}-${data.index}`}
            transition={layerMotion.transition}
          >
            {isGenerating ? (
              <>
                <WorkbenchArtifactFallback
                  phase="generating"
                  title={data.title}
                  variant="document"
                />
                <GeneratingWash mode="document" />
              </>
            ) : isRefining && data.artifact ? (
              <>
                <WorkbenchArtifactContent
                  reference={data.artifact}
                />
                <GeneratingWash mode="light" />
              </>
            ) : isRefining ? (
              <>
                <WorkbenchArtifactFallback
                  phase="refining"
                  title={data.title}
                  variant="prototype"
                />
                <WorkbenchArtifactSkeleton variant="prototype" />
                <GeneratingWash mode="light" />
              </>
            ) : isReady ? (
              data.artifact
                ? (
                    <WorkbenchArtifactContent
                      editable={editing}
                      editingBusy={prototypeEditor.busy}
                      onDocumentCommit={prototypeEditor.onDocumentCommit}
                      reference={data.artifact}
                    />
                  )
                : (
                    <WorkbenchArtifactFallback
                      phase="complete"
                      title={data.title}
                      variant="prototype"
                    />
                  )
            ) : (
              <WorkbenchArtifactFallback
                phase="complete"
                title={data.title}
                variant="prototype"
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

function GeneratingWash({ mode = "document" }: { mode?: "document" | "light" }) {
  const isDocument = mode === "document";
  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute inset-0",
          isDocument ? "bg-[#dce0db]/10" : "bg-[#111315]/18",
        )}
      />
      {isDocument && (
        <div
          className="workbench-document-wash pointer-events-none absolute inset-y-0 left-[-18%] w-[136%] bg-[linear-gradient(90deg,transparent_0%,rgba(90,112,255,0.12)_32%,rgba(138,185,166,0.24)_52%,rgba(124,86,202,0.12)_70%,transparent_100%)]"
          data-motion="document-wash"
        />
      )}
      <div
        className={cn(
          "workbench-generating-beam pointer-events-none absolute inset-y-0 w-[46%] bg-[linear-gradient(90deg,transparent,rgba(170,203,190,0.26),transparent)] blur-[18px]",
          !isDocument && "workbench-generating-beam--light w-[110px] bg-[linear-gradient(90deg,transparent,rgba(180,204,196,0.18),transparent)]",
        )}
        data-motion="generation-beam"
      />
    </>
  );
}
