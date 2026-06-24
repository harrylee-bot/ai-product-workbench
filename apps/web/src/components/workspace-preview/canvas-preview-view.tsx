"use client";

import { GitBranch, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui";
import { EmptyPreview } from "./empty-preview";
import type { DocumentCanvasPreview, JsonCanvasEdge, JsonCanvasNode, Phase1PrdPreview } from "./types";

export function CanvasPreviewView({
  prdPreview,
  canvasPreview,
  loading,
  error,
}: {
  prdPreview?: Phase1PrdPreview | null;
  canvasPreview?: DocumentCanvasPreview | null;
  loading?: boolean;
  error?: string | null;
}) {
  if (!prdPreview) {
    return (
      <div className="h-full p-4">
        <EmptyPreview title="暂无 Canvas" description="生成 PRD 后会在这里展示结构化画布。" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-white">
        <div className="flex items-center gap-2 rounded-[10px] border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 shadow-[var(--shadow-control)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Canvas 生成中
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full p-4">
        <EmptyPreview title="Canvas 生成失败" description={error} />
      </div>
    );
  }

  if (!canvasPreview?.canvas.nodes.length) {
    return (
      <div className="h-full p-4">
        <EmptyPreview title="暂无 Canvas 节点" description="当前 PRD 没有可转换的章节结构。" />
      </div>
    );
  }

  const layout = canvasLayout(canvasPreview.canvas.nodes);
  const nodeMap = new Map(canvasPreview.canvas.nodes.map((node) => [node.id, node]));

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-950">
            <GitBranch className="h-4 w-4 text-blue-600" />
            <span className="truncate">{canvasPreview.title}</span>
          </div>
          <div className="truncate text-xs text-gray-500">
            PDS v{canvasPreview.productDesignStateVersion} · {canvasPreview.stats.nodeCount} nodes · {canvasPreview.stats.edgeCount} edges
          </div>
        </div>
        <Badge tone="accent" className="bg-blue-50">JSON Canvas</Badge>
      </div>

      <div className="workbench-scrollbar min-h-0 flex-1 overflow-auto bg-gray-50">
        <div
          className="relative"
          style={{
            width: layout.width,
            height: layout.height,
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={layout.width}
            height={layout.height}
            aria-hidden="true"
          >
            <defs>
              <marker id="canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" fill="#64748b" />
              </marker>
            </defs>
            {canvasPreview.canvas.edges.map((edge) => {
              const from = nodeMap.get(edge.fromNode);
              const to = nodeMap.get(edge.toNode);
              if (!from || !to) return null;
              const start = anchorPoint(from, edge.fromSide ?? "right", layout);
              const end = anchorPoint(to, edge.toSide ?? "left", layout);
              const midX = (start.x + end.x) / 2;
              return (
                <g key={edge.id}>
                  <path
                    d={`M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`}
                    fill="none"
                    stroke="#64748b"
                    strokeWidth="1.5"
                    markerEnd={edge.toEnd === "none" ? undefined : "url(#canvas-arrow)"}
                  />
                  {edge.label ? (
                    <text x={midX} y={(start.y + end.y) / 2 - 6} fill="#64748b" fontSize="11" textAnchor="middle">
                      {edge.label}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>

          {canvasPreview.canvas.nodes.map((node) => (
            <CanvasNode key={node.id} node={node} layout={layout} />
          ))}
        </div>
      </div>
    </div>
  );
}

function CanvasNode({ node, layout }: { node: JsonCanvasNode; layout: CanvasLayout }) {
  const text = node.text ?? node.label ?? "";
  return (
    <div
      className={[
        "absolute overflow-hidden border px-3 py-2 text-xs leading-5 shadow-[var(--shadow-control)]",
        node.type === "group" ? "border-dashed bg-white/35" : "bg-white",
        colorClass(node.color),
      ].join(" ")}
      style={{
        left: node.x + layout.offsetX,
        top: node.y + layout.offsetY,
        width: node.width,
        height: node.height,
        borderRadius: 8,
      }}
      title={text}
    >
      <div className="h-full overflow-hidden whitespace-pre-wrap break-words text-gray-700">
        {text}
      </div>
    </div>
  );
}

type CanvasLayout = {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

function canvasLayout(nodes: JsonCanvasNode[]): CanvasLayout {
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  const padding = 48;
  return {
    offsetX: padding - minX,
    offsetY: padding - minY,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

function anchorPoint(node: JsonCanvasNode, side: NonNullable<JsonCanvasEdge["fromSide"]>, layout: CanvasLayout) {
  const left = node.x + layout.offsetX;
  const top = node.y + layout.offsetY;
  if (side === "left") return { x: left, y: top + node.height / 2 };
  if (side === "right") return { x: left + node.width, y: top + node.height / 2 };
  if (side === "top") return { x: left + node.width / 2, y: top };
  return { x: left + node.width / 2, y: top + node.height };
}

function colorClass(color?: string) {
  if (color === "1") return "border-red-200 bg-red-50";
  if (color === "2") return "border-amber-200 bg-amber-50";
  if (color === "3") return "border-yellow-200 bg-yellow-50";
  if (color === "4") return "border-emerald-200 bg-emerald-50";
  if (color === "5") return "border-cyan-200 bg-cyan-50";
  if (color === "6") return "border-violet-200 bg-violet-50";
  return "border-gray-200";
}
