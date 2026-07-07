"use client";

import {
  Background,
  BackgroundVariant,
  type Node,
  type NodeProps,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  BotIcon,
  BrushIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  CpuIcon,
  FileTextIcon,
  FrameIcon,
  HandIcon,
  HelpCircleIcon,
  HistoryIcon,
  ImageIcon,
  LayoutPanelTopIcon,
  MicIcon,
  MousePointer2Icon,
  PaletteIcon,
  PaperclipIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  SearchIcon,
  SparklesIcon,
  StarsIcon,
  Undo2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, SVGProps } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type View = "home" | "project";
type ProjectMode = "board" | "focus";
type Phase = "idle" | "generating" | "refining" | "complete";
type ToolId = "select" | "frame" | "draw" | "pan" | "media" | "style" | "special";

type ArtboardData = {
  phase: Phase;
};

type BoardTileData = {
  accent: string;
  kind: "screen" | "image" | "doc" | "palette";
  subtitle: string;
  title: string;
};

type ArtboardNode = Node<ArtboardData, "stitchArtboard">;
type BoardTileNode = Node<BoardTileData, "stitchTile">;
type StitchNode = ArtboardNode | BoardTileNode;

const stage = {
  width: 1440,
  height: 900,
  planeWidth: 1920,
  planeHeight: 1200,
  scale: 0.75,
};

const projectRows = [
  { id: "website", title: "Website UI Redesign", meta: "Web · Jul 7, 2026" },
  { id: "mobile", title: "Mobile App Shell", meta: "App · Jul 7, 2026" },
];

const examples = [
  "Main Dashboard",
  "Home Lookbook",
  "Vertical Feed",
  "Fleet Admin Dashboard",
];

const suggestions = [
  "Admin dashboard for a community seed bank",
  "Create a dashboard for Beehive Managers",
  "Home page for a bonsai trees shop",
];

const inspirationCards = [
  { accent: "#00dbe9", title: "AI 产品工作台", subtitle: "Dashboard shell" },
  { accent: "#ef4444", title: "Lumina Dark", subtitle: "Design system" },
  { accent: "#22c55e", title: "AionBench 首页", subtitle: "Landing page" },
];

const toolItems: Array<{ id: ToolId; icon: ComponentType<SVGProps<SVGSVGElement>>; label: string }> = [
  { id: "select", icon: MousePointer2Icon, label: "Select" },
  { id: "frame", icon: FrameIcon, label: "Frame" },
  { id: "draw", icon: PencilIcon, label: "Draw" },
  { id: "pan", icon: HandIcon, label: "Pan" },
  { id: "media", icon: ImageIcon, label: "Media" },
  { id: "style", icon: PaletteIcon, label: "Style" },
  { id: "special", icon: StarsIcon, label: "Special" },
];

const boardTiles: BoardTileNode[] = [
  {
    data: { accent: "#8b5cf6", kind: "screen", subtitle: "Web · current", title: "Stitch Workbench Canvas" },
    id: "tile-workbench",
    position: { x: 40, y: 10 },
    selected: true,
    style: { height: 260, width: 380 },
    type: "stitchTile",
  },
  {
    data: { accent: "#00dbe9", kind: "screen", subtitle: "Homepage", title: "AionBench 首页改版" },
    id: "tile-aionbench",
    position: { x: 500, y: 20 },
    style: { height: 240, width: 360 },
    type: "stitchTile",
  },
  {
    data: { accent: "#f97316", kind: "image", subtitle: "Reference", title: "Mountain visual variants" },
    id: "tile-visuals",
    position: { x: 940, y: 36 },
    style: { height: 180, width: 300 },
    type: "stitchTile",
  },
  {
    data: { accent: "#d0bcff", kind: "palette", subtitle: "Tokens", title: "Lumina Dark palette" },
    id: "tile-palette",
    position: { x: 220, y: 340 },
    style: { height: 210, width: 320 },
    type: "stitchTile",
  },
  {
    data: { accent: "#22c55e", kind: "screen", subtitle: "Dashboard", title: "AI 产品工作台 · 对话页" },
    id: "tile-dashboard",
    position: { x: 640, y: 330 },
    style: { height: 250, width: 380 },
    type: "stitchTile",
  },
  {
    data: { accent: "#e8eaed", kind: "doc", subtitle: "Spec", title: "Stitch 1:1 深度还原说明" },
    id: "tile-spec",
    position: { x: 80, y: 680 },
    style: { height: 250, width: 340 },
    type: "stitchTile",
  },
  {
    data: { accent: "#a078ff", kind: "doc", subtitle: "Export", title: "Redeploy export state" },
    id: "tile-export",
    position: { x: 520, y: 710 },
    style: { height: 230, width: 330 },
    type: "stitchTile",
  },
];

const artboardNodeTypes = {
  stitchArtboard: StitchArtboardNode,
  stitchTile: StitchBoardTileNode,
};

export function StitchWorkbench() {
  return (
    <ReactFlowProvider>
      <StitchWorkbenchInner />
    </ReactFlowProvider>
  );
}

function StitchWorkbenchInner() {
  const [view, setView] = useState<View>("home");
  const [projectMode, setProjectMode] = useState<ProjectMode>("board");
  const [phase, setPhase] = useState<Phase>("idle");
  const [prompt, setPrompt] = useState("");
  const [activeTool, setActiveTool] = useState<ToolId>("select");
  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const timersRef = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const openProject = useCallback(() => {
    clearTimers();
    setProjectMode("board");
    setPhase("idle");
    setView("project");
  }, [clearTimers]);

  const submitPrompt = useCallback((nextPrompt: string) => {
    const text = nextPrompt.trim();
    if (!text) return;

    clearTimers();
    setPrompt(text);
    setProjectMode("focus");
    setView("project");
    setPhase("generating");
    timersRef.current = [
      window.setTimeout(() => setPhase("refining"), 1600),
      window.setTimeout(() => setPhase("complete"), 5200),
    ];
  }, [clearTimers]);

  return (
    <main
      className="stitch-workbench relative h-[900px] w-[1440px] min-w-[1440px] max-w-[1440px] overflow-hidden bg-[#131314] text-[#e5e2e3]"
      data-stitch-stage
    >
      <div className="absolute left-0 top-0 h-[900px] w-[1440px] bg-[#131314]" />
      <div
        className="absolute left-0 top-0 origin-top-left overflow-hidden"
        style={{
          height: `${stage.planeHeight}px`,
          transform: `scale(${stage.scale})`,
          width: `${stage.planeWidth}px`,
        }}
      >
        <AnimatePresence mode="wait">
          {view === "home" ? (
            <HomeScreen
              key="home"
              onOpenProject={openProject}
              onSubmitPrompt={submitPrompt}
              prompt={prompt}
              setPrompt={setPrompt}
            />
          ) : (
            <ProjectScreen
              activeTool={activeTool}
              key="project"
              onBack={() => {
                clearTimers();
                setPhase("idle");
                setView("home");
              }}
              onExport={() => setExportOpen(true)}
              onOpenFocus={() => {
                clearTimers();
                setProjectMode("focus");
                setPhase("complete");
              }}
              onSelectTool={setActiveTool}
              onShare={() => setShareOpen(true)}
              onSubmitPrompt={submitPrompt}
              phase={phase}
              projectMode={projectMode}
              prompt={prompt}
              setPrompt={setPrompt}
            />
          )}
        </AnimatePresence>
      </div>
      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
    </main>
  );
}

function HomeScreen({
  onOpenProject,
  onSubmitPrompt,
  prompt,
  setPrompt,
}: {
  onOpenProject: () => void;
  onSubmitPrompt: (prompt: string) => void;
  prompt: string;
  setPrompt: (prompt: string) => void;
}) {
  return (
    <motion.section
      animate={{ opacity: 1 }}
      className="absolute left-0 top-0 h-[1200px] w-[1920px] bg-[#131314] text-[#e5e2e3]"
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
    >
      <DottedBackdrop />
      <header className="absolute left-0 top-0 z-30 flex h-[92px] w-[1920px] items-center justify-between px-[28px]">
        <div className="flex items-center gap-[16px]">
          <div className="text-[48px] font-semibold leading-none">Stitch</div>
          <span className="rounded-full border border-white/70 px-[14px] py-[6px] text-[17px] font-semibold uppercase leading-none">
            Beta
          </span>
        </div>
        <div className="flex items-center gap-[14px]">
          <button className="stitch-control h-[56px] gap-[12px] px-[24px] text-[19px]" type="button">
            <FileTextIcon className="size-[24px]" />
            Docs
          </button>
          <button className="stitch-icon-button size-[56px]" type="button">
            <SparklesIcon className="size-[24px]" />
          </button>
          <div className="grid size-[48px] place-items-center rounded-full bg-[#496068] text-[22px] font-semibold">
            L
          </div>
        </div>
      </header>

      <aside className="stitch-glass absolute bottom-[32px] left-[32px] top-[132px] z-20 w-[620px] rounded-[28px] p-[32px]">
        <div className="mb-[32px] grid h-[72px] grid-cols-2 rounded-full bg-[#111213]/90 p-[8px]">
          <button className="rounded-full bg-[#3a3d40] text-[21px] font-semibold text-[#f1f3f4]" type="button">
            我的项目
          </button>
          <button className="rounded-full text-[21px] font-semibold text-[#9aa0a6]" type="button">
            与我共享
          </button>
        </div>
        <label className="mb-[40px] flex h-[66px] items-center gap-[16px] rounded-full bg-[#2a2b2d]/94 px-[24px] text-[#aeb3bb]">
          <SearchIcon className="size-[24px]" />
          <input
            className="w-[468px] bg-transparent text-[21px] font-medium outline-none placeholder:text-[#8d9299]"
            placeholder="搜索项目"
          />
        </label>
        <ProjectList title="昨天">
          {projectRows.map((project) => (
            <button
              className="group flex h-[102px] w-[556px] items-center gap-[20px] rounded-[22px] p-[12px] text-left transition hover:-translate-y-[2px] hover:bg-white/[0.06] active:scale-[0.98]"
              key={project.id}
              onClick={onOpenProject}
              type="button"
            >
              <span className="h-[78px] w-[96px] shrink-0 overflow-hidden rounded-[10px] border border-white/[0.08] bg-[radial-gradient(circle_at_30%_25%,#7df4ff,#5516be_52%,#0e0e0f)]" />
              <span className="w-[416px]">
                <span className="block truncate text-[22px] font-semibold">{project.title}</span>
                <span className="mt-[8px] block truncate text-[15px] font-medium text-[#9aa0a6]">
                  {project.meta}
                </span>
              </span>
            </button>
          ))}
        </ProjectList>
        <ProjectList className="mt-[48px]" title="示例">
          {examples.map((example) => (
            <button
              className="flex h-[78px] w-[556px] items-center gap-[20px] rounded-[22px] p-[12px] text-left transition hover:-translate-y-[2px] hover:bg-white/[0.06] active:scale-[0.98]"
              key={example}
              onClick={onOpenProject}
              type="button"
            >
              <span className="h-[54px] w-[72px] rounded-[10px] bg-[linear-gradient(135deg,#24272b,#745cff)]" />
              <span className="truncate text-[20px] font-semibold">{example}</span>
            </button>
          ))}
        </ProjectList>
      </aside>

      <section className="absolute left-[690px] top-[286px] z-10 w-[1120px]">
        <div className="mb-[30px] flex justify-center">
          <div className="rounded-full border border-white/[0.08] bg-[#1c1d20]/92 px-[34px] py-[15px] text-[20px] font-semibold text-[#d8dce4] shadow-[0_14px_52px_-32px_rgba(0,0,0,0.92)]">
            Google I/O: <span className="text-[#7b64ff]">5 Major Upgrades</span>
          </div>
        </div>
        <h1 className="max-w-[950px] text-[76px] font-medium leading-none tracking-normal">
          欢迎使用 Stitch...
        </h1>
      </section>

      <HomeComposer
        onSubmitPrompt={onSubmitPrompt}
        prompt={prompt}
        setPrompt={setPrompt}
      />
      <InspirationStrip />
    </motion.section>
  );
}

function ProjectList({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <section className={className}>
      <h2 className="mb-[24px] text-[26px] font-semibold text-[#cfd3da]">{title}</h2>
      <div className="space-y-[8px]">{children}</div>
    </section>
  );
}

function HomeComposer({
  onSubmitPrompt,
  prompt,
  setPrompt,
}: {
  onSubmitPrompt: (prompt: string) => void;
  prompt: string;
  setPrompt: (prompt: string) => void;
}) {
  return (
    <div className="absolute left-[660px] top-[610px] z-30 w-[1080px]">
      <div className="stitch-glass rounded-[30px] p-[28px]">
        <textarea
          className="h-[158px] w-[1024px] resize-none bg-transparent text-[24px] leading-[32px] outline-none placeholder:text-[#8a8f97]"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSubmitPrompt(prompt);
            }
          }}
          placeholder="您想更改或创建什么内容？"
          value={prompt}
        />
        <div className="mt-[18px] flex items-center gap-[16px]">
          <PlusIcon className="size-[24px]" />
          <span className="text-[28px] leading-none">/</span>
          <div className="w-[690px]" />
          <button className="stitch-control h-[40px] px-[16px] text-[17px]" type="button">
            <SparklesIcon className="size-[20px]" />
            3.1 Pro
            <ChevronDownIcon className="size-[16px]" />
          </button>
          <button
            className="grid size-[48px] place-items-center rounded-full bg-[#d2a4ff] text-[#1d1b20] transition hover:-translate-y-[2px] active:scale-[0.98]"
            onClick={() => onSubmitPrompt(prompt || suggestions[0])}
            type="button"
          >
            <ArrowUpIcon className="size-[24px]" />
          </button>
        </div>
      </div>
      <div className="mt-[28px] flex gap-[16px] overflow-hidden">
        {suggestions.map((suggestion) => (
          <button
            className="h-[56px] max-w-[430px] shrink-0 truncate rounded-full border border-white/[0.10] bg-[#252629]/90 px-[28px] text-[21px] font-medium transition hover:-translate-y-[2px] hover:bg-white/[0.08] active:scale-[0.98]"
            key={suggestion}
            onClick={() => onSubmitPrompt(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function InspirationStrip() {
  return (
    <section className="absolute left-[690px] top-[980px] z-20 w-[1120px]">
      <h2 className="mb-[26px] text-[40px] font-semibold leading-none text-[#f1f3f4]">
        需要灵感?
      </h2>
      <div className="flex gap-[28px]">
        {inspirationCards.map((card) => (
          <article
            className="stitch-glass h-[240px] w-[336px] overflow-hidden rounded-[18px]"
            key={card.title}
          >
            <div
              className="h-[164px] w-[336px]"
              style={{
                background: `radial-gradient(circle at 18% 12%, ${card.accent}, transparent 26%), linear-gradient(135deg, #101113 0%, #23242a 48%, #0d0e0f 100%)`,
              }}
            >
              <div className="grid h-[164px] w-[336px] grid-cols-2 gap-[10px] p-[18px]">
                <span className="rounded-[10px] bg-white/[0.10]" />
                <span className="rounded-[10px] bg-white/[0.07]" />
                <span className="rounded-[10px] bg-white/[0.07]" />
                <span className="rounded-[10px] bg-white/[0.10]" />
              </div>
            </div>
            <div className="px-[18px] py-[13px]">
              <h3 className="truncate text-[18px] font-semibold text-[#e8eaed]">{card.title}</h3>
              <p className="mt-[4px] truncate font-mono text-[12px] text-[#9aa0a6]">{card.subtitle}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProjectScreen({
  activeTool,
  onBack,
  onExport,
  onOpenFocus,
  onSelectTool,
  onShare,
  onSubmitPrompt,
  phase,
  projectMode,
  prompt,
  setPrompt,
}: {
  activeTool: ToolId;
  onBack: () => void;
  onExport: () => void;
  onOpenFocus: () => void;
  onSelectTool: (tool: ToolId) => void;
  onShare: () => void;
  onSubmitPrompt: (prompt: string) => void;
  phase: Phase;
  projectMode: ProjectMode;
  prompt: string;
  setPrompt: (prompt: string) => void;
}) {
  const nodes = useMemo<StitchNode[]>(
    () => projectMode === "board"
      ? boardTiles
      : [
          {
            data: { phase },
            draggable: true,
            id: "landing-page",
            position: { x: 0, y: 0 },
            selected: true,
            style: { height: 800, width: 1200 },
            type: "stitchArtboard",
          },
        ],
    [phase, projectMode],
  );
  const viewport = projectMode === "board"
    ? { x: 520, y: 112, zoom: 0.52 }
    : { x: 470, y: 160, zoom: 1 };

  return (
    <motion.section
      animate={{ opacity: 1 }}
      className="absolute left-0 top-0 h-[1200px] w-[1920px] bg-[#131314] text-[#e5e2e3]"
      data-stitch-project
      exit={{ opacity: 0 }}
      initial={{ opacity: 0 }}
    >
      <ProjectTopBar onBack={onBack} onExport={onExport} onShare={onShare} />
      <LeftInspector phase={phase} projectMode={projectMode} prompt={prompt} />
      <RightToolRail activeTool={activeTool} onSelectTool={onSelectTool} />
      <div className="absolute left-0 top-0 h-[1200px] w-[1920px]">
        <ReactFlow
          className="stitch-flow h-[1200px] w-[1920px]"
          colorMode="dark"
          defaultViewport={viewport}
          fitView={false}
          key={projectMode}
          maxZoom={1.25}
          minZoom={0.08}
          nodeTypes={artboardNodeTypes}
          nodes={nodes}
          nodesDraggable
          onNodeClick={(_, node) => {
            if (node.type === "stitchTile") onOpenFocus();
          }}
          panOnDrag={activeTool === "pan" || activeTool === "select"}
          proOptions={{ hideAttribution: true }}
          selectionOnDrag={activeTool === "select"}
        >
          <Background
            color="#333"
            gap={20}
            size={1}
            variant={BackgroundVariant.Dots}
          />
        </ReactFlow>
      </div>
      <ProjectComposer
        onSubmitPrompt={onSubmitPrompt}
        phase={phase}
        projectMode={projectMode}
        prompt={prompt}
        setPrompt={setPrompt}
      />
      <CanvasAgentPills projectMode={projectMode} />
      <UtilityPill zoomLabel={projectMode === "board" ? "10%" : "100%"} />
    </motion.section>
  );
}

function ProjectTopBar({
  onBack,
  onExport,
  onShare,
}: {
  onBack: () => void;
  onExport: () => void;
  onShare: () => void;
}) {
  return (
    <header className="absolute left-0 top-0 z-50 flex h-[64px] w-[1920px] items-center justify-between bg-[#131314]/70 px-[20px] text-[13px] backdrop-blur-xl">
      <button
        className="flex h-[42px] items-center gap-[12px] rounded-[21px] px-[12px] text-left transition hover:-translate-y-[2px] hover:bg-[#353436]/50 active:scale-[0.98]"
        onClick={onBack}
        type="button"
      >
        <ArrowLeftIcon className="size-[18px] text-[#cbc3d7]" />
        <span className="text-[17px] font-semibold leading-[25px]">Website UI Redesign</span>
      </button>
      <div className="flex items-center gap-[10px]">
        <button className="stitch-icon-button size-[44px]" type="button">
          <PlayIcon className="size-[20px]" />
        </button>
        <button
          className="stitch-control h-[42px] px-[18px] font-mono text-[12px]"
          onClick={onShare}
          type="button"
        >
          Share
        </button>
        <button
          className="h-[42px] rounded-[21px] bg-[#a078ff] px-[20px] text-[13px] font-bold text-[#340080] shadow-[0_12px_36px_-18px_rgba(160,120,255,0.9)] transition hover:-translate-y-[2px] hover:bg-[#d0bcff] active:scale-[0.98]"
          onClick={onExport}
          type="button"
        >
          Export
        </button>
        <div className="ml-[4px] grid size-[44px] place-items-center rounded-full border border-[#494454]/20 bg-[#496068] text-[16px] font-semibold text-[#f1f3f4]">
          L
        </div>
      </div>
    </header>
  );
}

function LeftInspector({
  phase,
  projectMode,
  prompt,
}: {
  phase: Phase;
  projectMode: ProjectMode;
  prompt: string;
}) {
  const activeCopy =
    projectMode === "board"
      ? "Waiting for a canvas selection..."
      : phase === "complete"
        ? "Polishing component states..."
        : "Synthesizing layout...";
  const statusCopy =
    projectMode === "board"
      ? "Board overview"
      : phase === "generating"
        ? "Thinking..."
        : "Reworking the screen...";

  return (
    <aside className="pointer-events-none absolute bottom-[24px] left-[24px] top-[84px] z-30 flex w-[292px] select-none flex-col gap-[12px]">
      <section className="stitch-glass pointer-events-auto rounded-[12px] p-[16px] shadow-lg">
        <div className="mb-[12px] flex items-center gap-[8px]">
          <BotIcon className="size-[16px] text-[#00dbe9]" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#cbc3d7]">
            Assistant Active
          </span>
        </div>
        <div className="mb-[12px] flex items-start gap-[12px] rounded-[8px] border border-[#494454]/10 bg-[#201f20]/50 p-[12px]">
          <div className="mt-[2px] size-[24px] shrink-0 rounded-full bg-[radial-gradient(circle_at_30%_30%,#7df4ff,#5516be_52%,#0e0e0f)]" />
          <p className="truncate text-[13px] leading-[19px]">
            "{prompt || (projectMode === "board" ? "Select a frame or describe a change..." : "Design a minimalist landing page...")}"
          </p>
        </div>
        <p className="text-[12px] leading-[18px] text-[#cbc3d7]">
          {projectMode === "board"
            ? "Project frames, references, token cards, and export notes are laid out on the canvas. Click any thumbnail to zoom into the selected frame."
            : "Analyzing requirements. Structuring hero section with high-contrast typography and establishing core glassmorphic layers for interactive elements."}
        </p>
        <div className="mt-[12px] flex items-center gap-[8px] border-t border-[#494454]/10 pt-[12px]">
          <span className="size-[12px] animate-spin rounded-full border-2 border-[#d0bcff]/30 border-t-[#d0bcff]" />
          <span className="font-mono text-[11px] italic text-[#d0bcff]/80">{statusCopy}</span>
        </div>
        <div className="stitch-aurora mt-[12px] h-[2px] w-[248px] rounded-full" />
      </section>
      <section className="stitch-glass pointer-events-auto h-[760px] rounded-[12px] p-[16px] shadow-lg">
        <div className="mb-[16px] flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#cbc3d7]">
            智能体日志 (Agent Log)
          </h3>
          <HistoryIcon className="size-[14px] text-[#cbc3d7]" />
        </div>
        <div className="space-y-[8px]">
          <AgentRow done label="Initialize grid system" time="14:02:11" />
          <AgentRow done label="Generate color tokens" time="14:02:15" />
          <AgentRow active label={activeCopy} time="Running" />
          <AgentRow label="Apply shader effects" />
        </div>
      </section>
    </aside>
  );
}

function AgentRow({
  active,
  done,
  label,
  time,
}: {
  active?: boolean;
  done?: boolean;
  label: string;
  time?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-[34px] items-center gap-[12px] rounded-[8px] border p-[8px] font-mono text-[11px]",
        done && "border-[#494454]/5 bg-[#353436]/30",
        active && "border-[#d0bcff]/20 bg-[#a078ff]/10",
        !active && !done && "border-transparent opacity-50",
      )}
    >
      {active ? (
        <span className="grid size-[16px] place-items-center">
          <span className="stitch-pulse size-[8px] rounded-full bg-[#d0bcff]" />
        </span>
      ) : done ? (
        <CheckCircle2Icon className="size-[16px] text-[#00a0aa]" />
      ) : (
        <CircleIcon className="size-[16px] text-[#958ea0]" />
      )}
      <span className={cn("w-[150px] truncate", active ? "text-[#d0bcff]" : "text-[#cbc3d7]")}>
        {label}
      </span>
      {time && (
        <span className={cn("text-[9px]", active ? "text-[#d0bcff]/70" : "text-[#958ea0]/50")}>
          {time}
        </span>
      )}
    </div>
  );
}

function RightToolRail({
  activeTool,
  onSelectTool,
}: {
  activeTool: ToolId;
  onSelectTool: (tool: ToolId) => void;
}) {
  return (
    <nav className="stitch-glass absolute right-[22px] top-[344px] z-40 flex w-[64px] flex-col items-center gap-[12px] rounded-full py-[8px] shadow-lg">
      {toolItems.map((tool, index) => {
        const Icon = tool.icon;
        return (
          <button
            className={cn(
              "relative grid size-[48px] place-items-center rounded-full text-[#cbc3d7] transition hover:-translate-y-[2px] hover:bg-[#3a393a]/45 active:scale-[0.98]",
              activeTool === tool.id && "bg-[#f1f3f4] text-[#202124]",
            )}
            key={tool.id}
            onClick={() => onSelectTool(tool.id)}
            title={tool.label}
            type="button"
          >
            {index === 4 && <span className="absolute -top-[6px] h-px w-[38px] bg-[#494454]/30" />}
            <Icon className="size-[20px]" />
          </button>
        );
      })}
    </nav>
  );
}

function StitchBoardTileNode({ data, selected }: NodeProps<BoardTileNode>) {
  const Icon = data.kind === "doc"
    ? FileTextIcon
    : data.kind === "image"
      ? ImageIcon
      : data.kind === "palette"
        ? PaletteIcon
        : LayoutPanelTopIcon;

  return (
    <section
      className={cn(
        "group relative overflow-hidden rounded-[10px] border bg-[#161719] shadow-2xl transition hover:-translate-y-[2px] active:scale-[0.98]",
        selected ? "border-[#8b5cf6]" : "border-[#494454]/20",
      )}
      style={{
        height: `${data.kind === "image" ? 180 : data.kind === "doc" ? 250 : data.kind === "palette" ? 210 : 260}px`,
        width: `${data.kind === "image" ? 300 : data.kind === "doc" ? 340 : data.kind === "palette" ? 320 : 380}px`,
      }}
    >
      <div
        className="absolute left-0 top-0 h-[170px] w-[380px]"
        style={{
          background:
            data.kind === "doc"
              ? `linear-gradient(135deg, #1f2022, #292a2d 58%, ${data.accent} 140%)`
              : `radial-gradient(circle at 26% 20%, ${data.accent}, transparent 28%), linear-gradient(135deg, #111215, #24232c 52%, #0d0e10)`,
        }}
      />
      <div className="absolute left-[16px] top-[14px] flex h-[28px] items-center gap-[6px] rounded-full bg-[#0d0e10]/70 px-[10px] font-mono text-[11px] text-[#e8eaed] backdrop-blur-xl">
        <Icon className="size-[14px]" />
        {data.kind}
      </div>
      {data.kind === "doc" ? (
        <div className="absolute left-[26px] top-[58px] space-y-[10px]">
          <span className="block h-[8px] w-[220px] rounded-full bg-white/80" />
          <span className="block h-[6px] w-[260px] rounded-full bg-white/25" />
          <span className="block h-[6px] w-[238px] rounded-full bg-white/18" />
          <span className="block h-[6px] w-[190px] rounded-full bg-white/18" />
        </div>
      ) : data.kind === "palette" ? (
        <div className="absolute left-[24px] top-[60px] flex gap-[12px]">
          {["#ffffff", data.accent, "#00dbe9", "#1f2022"].map((color) => (
            <span
              className="block size-[36px] rounded-full border border-white/20"
              key={color}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>
      ) : (
        <div className="absolute bottom-[74px] left-[22px] grid h-[72px] w-[150px] grid-cols-2 gap-[8px]">
          <span className="rounded-[8px] bg-white/12" />
          <span className="rounded-[8px] bg-white/8" />
          <span className="rounded-[8px] bg-white/8" />
          <span className="rounded-[8px] bg-white/12" />
        </div>
      )}
      <div className="absolute bottom-0 left-0 h-[64px] w-[380px] border-t border-white/[0.06] bg-[#1b1c1f]/96 px-[14px] py-[10px]">
        <div className="truncate text-[14px] font-semibold text-[#e8eaed]">{data.title}</div>
        <div className="mt-[4px] truncate font-mono text-[10px] text-[#9aa0a6]">{data.subtitle}</div>
      </div>
    </section>
  );
}

function StitchArtboardNode({ data }: NodeProps<ArtboardNode>) {
  const handles = [
    "left-[-5px] top-[-5px]",
    "right-[-5px] top-[-5px]",
    "bottom-[-5px] left-[-5px]",
    "bottom-[-5px] right-[-5px]",
    "left-[-5px] top-[395px]",
    "right-[-5px] top-[395px]",
    "left-[595px] top-[-5px]",
    "bottom-[-5px] left-[595px]",
  ];

  return (
    <section className="relative h-[800px] w-[1200px] bg-[#131314] shadow-2xl">
      <div className="pointer-events-none absolute left-0 top-0 z-20 h-[800px] w-[1200px] border-2 border-[#8b5cf6]" />
      {handles.map((classes) => (
        <span
          className={cn("absolute z-30 size-[10px] border border-[#8b5cf6] bg-white", classes)}
          key={classes}
        />
      ))}
      <div className="absolute left-0 top-[-28px] z-30 flex h-[28px] items-center gap-[4px] rounded-t-[6px] bg-[#8b5cf6] px-[8px] font-mono text-[11px] leading-none text-white">
        <LayoutPanelTopIcon className="size-[12px]" />
        Landing_Page_v2.frame
      </div>
      <div className="relative h-[800px] w-[1200px] overflow-hidden bg-[#0e0e0f]">
        <ShaderCanvas />
        <div className="pointer-events-none absolute left-0 top-0 z-10 flex h-[800px] w-[1200px] items-center justify-center">
          <div className="stitch-glass flex h-[50px] items-center gap-[12px] rounded-full px-[24px]">
            <span className="size-[16px] animate-spin rounded-full border-2 border-[#d0bcff] border-t-transparent" />
            <span className="text-[18px] font-semibold text-[#d0bcff]">
              {data.phase === "complete" ? "界面已生成" : "正在生成界面..."}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function ShaderCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    if (!(gl instanceof WebGLRenderingContext)) return;

    const syncSize = () => {
      const width = canvas.clientWidth || 1200;
      const height = canvas.clientHeight || 800;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    };

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, "attribute vec2 a_position; varying vec2 v_texCoord; void main(){ v_texCoord=a_position*0.5+0.5; gl_Position=vec4(a_position,0.0,1.0); }");
    const fragment = compile(gl.FRAGMENT_SHADER, "precision highp float; varying vec2 v_texCoord; uniform float u_time; void main(){ vec2 uv=v_texCoord; float scan=sin(uv.x*3.0+u_time*2.0)*0.5+0.5; float beam=smoothstep(0.45,0.5,1.0-abs(uv.x-(mod(u_time*0.5,1.5)-0.25)))*0.3; vec3 base=vec3(0.08,0.08,0.10); vec3 aurora=vec3(0.5,0.3,0.9)*scan*0.2; vec3 ray=vec3(0.6,0.4,1.0)*beam; float noise=fract(sin(dot(uv,vec2(12.9898,78.233)))*43758.5453); gl_FragColor=vec4(base+aurora+ray+noise*0.02,0.95); }");
    const program = gl.createProgram();
    if (!program || !vertex || !fragment) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const time = gl.getUniformLocation(program, "u_time");

    const resizeObserver = new ResizeObserver(syncSize);
    resizeObserver.observe(canvas);
    let frame = 0;
    const render = (timestamp: number) => {
      syncSize();
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (time) gl.uniform1f(time, timestamp * 0.001);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, []);

  return (
    <canvas
      className="absolute left-0 top-0 block h-[800px] w-[1200px]"
      data-stitch-panel="shader-canvas"
      ref={canvasRef}
    />
  );
}

function ProjectComposer({
  onSubmitPrompt,
  phase,
  projectMode,
  prompt,
  setPrompt,
}: {
  onSubmitPrompt: (prompt: string) => void;
  phase: Phase;
  projectMode: ProjectMode;
  prompt: string;
  setPrompt: (prompt: string) => void;
}) {
  const chips = [
    [projectMode === "board" ? "Zoom selected" : "Make it darker", WandSparklesIcon],
    [projectMode === "board" ? "New frame" : "Add a hero", ImageIcon],
    [projectMode === "board" ? "Arrange board" : "Bento layout", LayoutPanelTopIcon],
  ] as const;

  return (
    <div className="absolute bottom-[28px] left-[454px] z-40 flex w-[1014px] flex-col items-center gap-[12px]">
      <div className="flex gap-[8px]">
        {chips.map(([label, Icon]) => (
          <button
            className="stitch-glass flex h-[32px] items-center gap-[6px] rounded-full px-[14px] font-mono text-[12px] text-[#cbc3d7] transition hover:-translate-y-[2px] hover:text-[#d0bcff] active:scale-[0.98]"
            key={label}
            onClick={() => {
              if (projectMode === "board" && label === "Zoom selected") {
                onSubmitPrompt("Open the selected Stitch frame");
                return;
              }
              setPrompt(label);
            }}
            type="button"
          >
            <Icon className="size-[14px]" />
            {label}
          </button>
        ))}
      </div>
      <div className="stitch-glass group relative flex w-[1014px] flex-col gap-[8px] overflow-hidden rounded-[28px] p-[16px] shadow-2xl">
        <div className="flex h-[48px] items-center gap-[10px]">
          <button className="grid size-[40px] place-items-center rounded-full text-[#cfd3da] hover:bg-[#3a393a]/50" type="button">
            <PlusIcon className="size-[20px]" />
          </button>
          <div className="h-[18px] w-px bg-[#494454]/30" />
          <button className="grid size-[40px] place-items-center rounded-full font-mono text-[24px] text-[#cfd3da] hover:bg-[#3a393a]/50" type="button">
            /
          </button>
          <input
            className="h-[48px] w-[858px] border-none bg-transparent px-[10px] text-[16px] outline-none placeholder:text-[#6f747c]"
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmitPrompt(prompt || "Refine this Stitch screen");
            }}
            placeholder="您想更改或创建什么内容? (What do you want to change or create?)"
            value={prompt}
          />
        </div>
        <div className="flex h-[42px] items-center justify-between px-[4px]">
          <div className="flex gap-[8px]">
            {[PaperclipIcon, BrushIcon, CpuIcon, MicIcon].map((Icon, index) => (
              <button className="grid size-[36px] place-items-center rounded-[10px] text-[#aeb3bb] hover:bg-[#3a393a]/30" key={index} type="button">
                <Icon className="size-[18px]" />
              </button>
            ))}
          </div>
          <button
            className="grid size-[48px] place-items-center rounded-full bg-[#d2a4ff] text-[#1d1b20] shadow-[0_14px_42px_-20px_rgba(210,164,255,0.9)] hover:bg-[#c084fc] active:scale-[0.98]"
            onClick={() => onSubmitPrompt(prompt || "Refine this Stitch screen")}
            type="button"
          >
            {phase === "generating" ? <span className="size-[16px] animate-spin rounded-full border-2 border-white border-t-transparent" /> : <ArrowUpIcon className="size-[20px]" />}
          </button>
        </div>
      </div>
    </div>
  );
}

function CanvasAgentPills({ projectMode }: { projectMode: ProjectMode }) {
  return (
    <div className="absolute bottom-[30px] left-[24px] z-40 flex h-[58px] items-center gap-[10px]">
      <div className="stitch-glass flex h-[50px] items-center gap-[10px] rounded-full px-[16px] text-[17px] font-semibold text-[#e8eaed]">
        <CheckCircle2Icon className="size-[20px] text-[#cfd3da]" />
        {projectMode === "board" ? "Design board" : "Selected frame"}
      </div>
      <div className="stitch-glass flex h-[50px] items-center gap-[10px] rounded-full px-[18px] text-[17px] font-semibold text-[#e8eaed]">
        <SparklesIcon className="size-[20px] text-[#d0bcff]" />
        智能体
      </div>
    </div>
  );
}

function UtilityPill({ zoomLabel }: { zoomLabel: string }) {
  return (
    <div className="stitch-glass absolute bottom-[24px] right-[24px] z-40 flex h-[40px] items-center gap-[4px] rounded-full p-[4px] shadow-lg">
      <button className="grid size-[32px] place-items-center rounded-full text-[#958ea0] hover:bg-[#3a393a]/30" type="button">
        <Undo2Icon className="size-[18px]" />
      </button>
      <button className="grid size-[32px] place-items-center rounded-full text-[#958ea0]/50" type="button">
        <Redo2Icon className="size-[18px]" />
      </button>
      <div className="mx-[4px] h-[16px] w-px bg-[#494454]/30" />
      <button className="flex h-[32px] items-center gap-[4px] rounded-full px-[8px] font-mono text-[11px] text-[#cbc3d7] hover:bg-[#3a393a]/30" type="button">
        {zoomLabel}
        <ChevronDownIcon className="size-[14px]" />
      </button>
      <div className="mx-[4px] h-[16px] w-px bg-[#494454]/30" />
      <button className="grid size-[32px] place-items-center rounded-full text-[#958ea0] hover:bg-[#3a393a]/30" type="button">
        <HelpCircleIcon className="size-[18px]" />
      </button>
    </div>
  );
}

function DottedBackdrop() {
  return (
    <div
      className="absolute left-0 top-0 h-[1200px] w-[1920px]"
      style={{
        backgroundImage: "radial-gradient(#333 1px, transparent 1px)",
        backgroundSize: "20px 20px",
      }}
    />
  );
}

function ShareDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="rounded-[28px] border-white/[0.08] bg-[#18191b]/96 text-[#e8eaed]">
        <DialogHeader>
          <DialogTitle>Share project</DialogTitle>
          <DialogDescription>Copy a preview link for this Stitch replica.</DialogDescription>
        </DialogHeader>
        <button
          className="h-[48px] rounded-full bg-[#e8eaed] text-[15px] font-semibold text-[#202124]"
          onClick={() => {
            console.log("share copied");
            onOpenChange(false);
          }}
          type="button"
        >
          Copy link
        </button>
      </DialogContent>
    </Dialog>
  );
}

function ExportDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const options = ["Figma", "MCP", "Netlify", "Lovable", "Bolt", ".zip", "Copy prompt"];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="h-[720px] max-w-[420px] rounded-[32px] border-white/[0.08] bg-[#18191b]/96 p-0 text-[#e8eaed]">
        <DialogHeader className="border-b border-white/[0.06] px-[36px] py-[32px]">
          <DialogTitle className="text-[30px]">Export</DialogTitle>
          <DialogDescription className="sr-only">Choose an export target.</DialogDescription>
        </DialogHeader>
        <div className="space-y-[12px] px-[36px] py-[28px]">
          {options.map((option) => (
            <button
              className="flex h-[54px] w-[348px] items-center gap-[18px] rounded-[16px] text-left text-[22px] hover:bg-white/[0.05]"
              key={option}
              onClick={() => console.log("export", option)}
              type="button"
            >
              <span className="grid size-[28px] place-items-center rounded-full border-2 border-white/[0.16]">
                {option === "MCP" && <span className="size-[14px] rounded-full bg-[#e8eaed]" />}
              </span>
              <span>{option}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
