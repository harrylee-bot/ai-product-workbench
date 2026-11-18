"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import type {
  GenerationPreview,
  GenerationPreviewNode,
} from "@workbench/workbench-contracts";
import type { SwarmController } from "./swarm/types";

type DraftPage = GenerationPreview["screens"][number];

// The engine is loaded only while an actual prototype projection is visible.
// It receives inert, validated nodes; frozen HTML and final iframe stay outside.
export function DraftProjection({
  page,
  available,
  running,
  updated,
  motionEnabled,
  onMotionEnabledChange,
}: {
  page: DraftPage;
  available: number;
  running: boolean;
  updated: boolean;
  motionEnabled: boolean;
  onMotionEnabledChange: (enabled: boolean) => void;
}) {
  const target = useRef<HTMLDivElement>(null);
  const controller = useRef<SwarmController | null>(null);
  const signatures = useRef(new Map<string, string>());
  const content = JSON.stringify(page.nodes);

  useEffect(() => {
    signatures.current = new Map(
      page.nodes.map((node) => [node.id, JSON.stringify(node)]),
    );
    controller.current?.updateProjection(signatures.current);
  }, [content]);

  useEffect(() => {
    if (!motionEnabled || !running || !target.current) return;
    let cancelled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const clearDeadline = () => {
      clearTimeout(deadline);
      deadline = undefined;
    };
    const dispose = () => {
      clearDeadline();
      controller.current?.destroy();
      controller.current = null;
    };
    const start = async () => {
      if (motion.matches) return;
      const { createSwarmRebuild } = await import("./swarm/engine");
      if (cancelled || motion.matches || !target.current) return;
      dispose();
      const swarm = createSwarmRebuild({
        target: target.current,
        scope: "target",
        projectionSignatures: signatures.current,
        cursorCount: 6,
        introDuration: 0,
        fadeIn: false,
        smoothTransition: false,
        burstOnComplete: false,
        typingSpeed: 100,
        speed: 1.5,
        maxLayers: 400,
        snapshotBudget: 4,
        showNames: false,
        showGuides: true,
        controls: false,
        sound: false,
        tour: false,
        zIndex: 30,
        onStateChange: ({ phase }) => {
          if (phase === "live" || phase === "idle") clearDeadline();
          // Drawing never holds an older projection over current content
          // indefinitely, even under continuous updates or a long text node.
          else if (deadline === undefined && phase !== "paused")
            deadline = setTimeout(() => {
              deadline = undefined;
              swarm.goLive();
            }, 2000);
        },
        onError: () => {
          clearDeadline();
          controller.current?.goLive();
        },
      });
      controller.current = swarm;
      swarm.start();
      if (document.hidden) swarm.pause();
    };
    const onMotion = () => {
      dispose();
      if (!motion.matches) void start().catch(dispose);
    };
    const onVisibility = () => {
      if (document.hidden) {
        clearDeadline();
        controller.current?.pause();
      } else controller.current?.resume();
    };
    motion.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVisibility);
    void start().catch(dispose);
    return () => {
      cancelled = true;
      motion.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisibility);
      dispose();
    };
  }, [motionEnabled, running]);

  return (
    <>
      {running && (
        <div className="visual-draft-motion">
          <button
            type="button"
            onClick={() => onMotionEnabledChange(!motionEnabled)}
          >
            {motionEnabled ? "关闭绘制动效" : "开启绘制动效"}
          </button>
        </div>
      )}
      <div className="visual-draft-scroll">
        <div
          ref={target}
          className="visual-draft-paper"
          data-draft-page={page.id}
          data-updated={updated}
          style={{
            width: page.width,
            minHeight: page.height,
            zoom: Math.max(0.1, Math.min(1, (available - 48) / page.width)),
          }}
        >
          <DraftNodes nodes={page.nodes} />
        </div>
      </div>
    </>
  );
}

function DraftNodes({ nodes }: { nodes: GenerationPreviewNode[] }) {
  const unique = new Map(nodes.map((node) => [node.id, node]));
  const render = (
    node: GenerationPreviewNode,
    ancestors: Set<string>,
  ): React.ReactNode => {
    if (ancestors.has(node.id)) return null;
    const next = new Set(ancestors).add(node.id);
    const style: CSSProperties = {
      position: node.absolute ? "absolute" : "relative",
      left: node.absolute ? node.x : undefined,
      top: node.absolute ? node.y : undefined,
      width: node.width ?? undefined,
      minHeight: node.height ?? undefined,
      display: "flex",
      flexDirection: node.direction,
      gap: node.gap,
      padding: node.padding,
      background: node.fill ?? undefined,
      color: node.color ?? undefined,
      borderRadius: node.radius,
      fontSize: node.fontSize ?? 14,
      flexShrink: 0,
      whiteSpace: "pre-wrap",
    };
    return (
      <div key={node.id} data-draft-node={node.id} style={style}>
        {node.text}
        {[...unique.values()]
          .filter((child) => child.parentId === node.id)
          .map((child) => render(child, next))}
      </div>
    );
  };
  return (
    <>
      {[...unique.values()]
        .filter((node) => !node.parentId || !unique.has(node.parentId))
        .map((node) => render(node, new Set()))}
    </>
  );
}
