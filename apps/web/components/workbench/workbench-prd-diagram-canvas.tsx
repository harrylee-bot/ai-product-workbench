"use client";

import type { PrdDocumentV2 } from "@workbench/workbench-contracts";

export type PrdDiagram = PrdDocumentV2["sections"]["businessRequirements"]["flowAndPages"]["diagrams"][number];

type DiagramCanvasNode = PrdDiagram["nodes"][number] & {
  x: number;
  y: number;
};

type DiagramRow = {
  group: string | null;
  nodes: PrdDiagram["nodes"];
};

export function WorkbenchPrdDiagramCanvas({ diagram }: { diagram: PrdDiagram }) {
  const width = 1000;
  const nodeWidth = diagram.kind === "productArchitecture" ? 220 : 190;
  const nodeHeight = 110;
  const horizontalGap = diagram.kind === "productArchitecture" ? 40 : 28;
  const verticalGap = 58;
  const groups = diagram.kind === "productArchitecture"
    ? [...new Set(diagram.nodes.map((node) => node.group || "业务模块"))]
    : [];
  const rows: DiagramRow[] = diagram.kind === "productArchitecture"
    ? groups.flatMap((group) => chunkNodes(
      diagram.nodes.filter((node) => (node.group || "业务模块") === group),
      4,
    ).map((nodes) => ({ group, nodes })))
    : chunkNodes(diagram.nodes, Math.min(4, Math.max(1, diagram.nodes.length)))
      .map((nodes) => ({ group: null, nodes }));
  const rowCount = Math.max(1, rows.length);
  const height = 40 + rowCount * nodeHeight + (rowCount - 1) * verticalGap;
  const nodes: DiagramCanvasNode[] = rows.flatMap((row, rowIndex) => {
    const totalWidth = row.nodes.length * nodeWidth + Math.max(0, row.nodes.length - 1) * horizontalGap;
    const startX = (width - totalWidth) / 2;
    return row.nodes.map((node, columnIndex) => ({
      ...node,
      x: startX + columnIndex * (nodeWidth + horizontalGap),
      y: 20 + rowIndex * (nodeHeight + verticalGap),
    }));
  });
  const positions = new Map(nodes.map((node) => [node.id, node]));
  const accent = diagram.kind === "productArchitecture" ? "#5ec7a5" : "#6ea8fe";
  const markerId = `prd-arrow-${diagram.id}`;

  return (
    <div className="mt-[18px] overflow-hidden border border-white/[0.12] bg-[#17181a]" data-prd-diagram-canvas>
      <svg
        aria-label={diagram.title}
        className="block h-auto w-full"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <title>{diagram.title}</title>
        <desc>{diagram.description}</desc>
        <defs>
          <marker
            id={markerId}
            markerHeight="7"
            markerWidth="7"
            orient="auto-start-reverse"
            refX="6"
            refY="3.5"
            viewBox="0 0 7 7"
          >
            <path d="M0,0 L7,3.5 L0,7 z" fill={accent} />
          </marker>
        </defs>
        {diagram.edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const start = { x: from.x + nodeWidth / 2, y: from.y + nodeHeight };
          const end = { x: to.x + nodeWidth / 2, y: to.y };
          const sameRow = Math.abs(from.y - to.y) < 1;
          const path = sameRow
            ? `M ${from.x + nodeWidth} ${from.y + nodeHeight / 2} C ${from.x + nodeWidth + 24} ${from.y + nodeHeight / 2}, ${to.x - 24} ${to.y + nodeHeight / 2}, ${to.x} ${to.y + nodeHeight / 2}`
            : `M ${start.x} ${start.y} C ${start.x} ${start.y + verticalGap / 2}, ${end.x} ${end.y - verticalGap / 2}, ${end.x} ${end.y}`;
          const labelX = sameRow
            ? (from.x + nodeWidth + to.x) / 2
            : (start.x + end.x) / 2;
          const labelY = sameRow
            ? from.y + nodeHeight / 2 - 9
            : (start.y + end.y) / 2;
          return (
            <g key={edge.id}>
              <title>{`${edge.from} → ${edge.to}${edge.label ? `：${edge.label}` : ""}`}</title>
              <path d={path} fill="none" markerEnd={`url(#${markerId})`} stroke={accent} strokeOpacity="0.72" strokeWidth="2" />
              {edge.label && (
                <text fill="#c7cad0" fontSize="13" textAnchor="middle" x={labelX} y={labelY}>{edge.label}</text>
              )}
            </g>
          );
        })}
        {rows.map((row, index) => row.group && (
          <text fill="#8f96a0" fontSize="12" fontWeight="600" key={`${row.group}-${index}`} textAnchor="start" x="18" y={31 + index * (nodeHeight + verticalGap)}>
            {row.group}
          </text>
        ))}
        {nodes.map((node) => (
          <g data-prd-diagram-node={node.id} key={node.id}>
            <title>{node.label}</title>
            <rect fill="#242629" height={nodeHeight} rx="6" stroke={accent} strokeOpacity="0.7" width={nodeWidth} x={node.x} y={node.y} />
            <text fill="#edf0f4" fontSize="15" fontWeight="600" textAnchor="middle" x={node.x + nodeWidth / 2} y={node.y + 31}>
              {wrapDiagramLabel(node.label, 16, 4).map((line, index) => (
                <tspan dy={index === 0 ? 0 : 19} key={`${node.id}-${index}`} x={node.x + nodeWidth / 2}>{line}</tspan>
              ))}
            </text>
            {node.group && diagram.kind !== "productArchitecture" && (
              <text fill="#8f96a0" fontSize="12" textAnchor="middle" x={node.x + nodeWidth / 2} y={node.y + nodeHeight - 13}>{node.group}</text>
            )}
          </g>
        ))}
      </svg>
      <span className="sr-only">{diagram.nodes.length} 个节点，{diagram.edges.length} 条关系</span>
    </div>
  );
}

function chunkNodes<Node>(nodes: readonly Node[], size: number): Node[][] {
  const chunks: Node[][] = [];
  for (let index = 0; index < nodes.length; index += size) chunks.push(nodes.slice(index, index + size) as Node[]);
  return chunks;
}

function wrapDiagramLabel(value: string, maxLength: number, maxLines: number): string[] {
  const chars = Array.from(value);
  if (chars.length <= maxLength) return [value];
  const lines = Array.from({ length: Math.ceil(chars.length / maxLength) }, (_, index) => (
    chars.slice(index * maxLength, (index + 1) * maxLength).join("")
  ));
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines - 1), `${lines[maxLines - 1]!.slice(0, maxLength - 1)}…`];
}
