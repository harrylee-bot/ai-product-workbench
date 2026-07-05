import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import type { RequirementDocBlock, RequirementDocSection, RequirementDocument } from "./ai-vibe.types";
import { RequirementDocumentService } from "./requirement-document.service";

type JsonCanvasNode =
  | {
      id: string;
      type: "text";
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      color?: string;
    }
  | {
      id: string;
      type: "group";
      x: number;
      y: number;
      width: number;
      height: number;
      label?: string;
      color?: string;
    };

type JsonCanvasEdge = {
  id: string;
  fromNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  fromEnd?: "none" | "arrow";
  toNode: string;
  toSide?: "top" | "right" | "bottom" | "left";
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
};

type JsonCanvasDocument = {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
};

export type DocumentCanvasView = {
  documentId: string;
  conversationId: string;
  title: string;
  conversationDesignStateId: string;
  conversationDesignStateVersion: number;
  canvas: JsonCanvasDocument;
  stats: {
    sectionCount: number;
    blockCount: number;
    nodeCount: number;
    edgeCount: number;
  };
  generatedAt: string;
};

type CanvasExportArtifact = {
  format: "prd_canvas";
  conversationId: string;
  title: string;
  sourceType: "requirement_document";
  sourceId: string;
  conversationDesignStateId: string;
  conversationDesignStateVersion: number;
  fileName: string;
  contentType: string;
  downloadPath: string;
  sizeBytes: number;
  generatedAt: string;
  buffer: Buffer;
};

@Injectable()
export class DocumentCanvasService {
  constructor(private readonly documentService: RequirementDocumentService) {}

  async getCanvasForUser(user: AuthenticatedUser, documentId: string) {
    const { document } = await this.documentService.getDocumentForUser(user, documentId);
    return buildDocumentCanvasView(document);
  }

  async getCurrentCanvasForUser(user: AuthenticatedUser, conversationId: string) {
    const current = await this.documentService.getCurrentForUser(user, conversationId);
    if (!current.document) throw new NotFoundException("PRD_CANVAS_NOT_FOUND");
    return buildDocumentCanvasView(current.document);
  }

  async createCanvasExportForUser(user: AuthenticatedUser, conversationId: string) {
    const view = await this.getCurrentCanvasForUser(user, conversationId);
    return buildCanvasExport(view);
  }

  async createCanvasExportForConversation(conversationId: string) {
    const current = await this.documentService.getCurrentForConversation(conversationId);
    if (!current.document) throw new NotFoundException("PRD_CANVAS_NOT_FOUND");
    return buildCanvasExport(buildDocumentCanvasView(current.document));
  }
}

export function buildDocumentCanvasView(document: RequirementDocument): DocumentCanvasView {
  const sections = [...document.sections].sort((left, right) => left.order - right.order);
  const canvas = buildJsonCanvas(document, sections);
  validateJsonCanvas(canvas);
  const blockCount = sections.reduce((sum, section) => sum + sectionBlocks(section).length, 0);
  return {
    documentId: document.id,
    conversationId: document.conversationId,
    title: document.title,
    conversationDesignStateId: document.conversationDesignStateId,
    conversationDesignStateVersion: document.conversationDesignStateVersion,
    canvas,
    stats: {
      sectionCount: sections.length,
      blockCount,
      nodeCount: canvas.nodes.length,
      edgeCount: canvas.edges.length,
    },
    generatedAt: new Date().toISOString(),
  };
}

function buildJsonCanvas(
  document: RequirementDocument,
  sections: RequirementDocSection[],
): JsonCanvasDocument {
  const nodes: JsonCanvasNode[] = [];
  const edges: JsonCanvasEdge[] = [];
  const rootId = idFor(document.id, "root");
  nodes.push({
    id: rootId,
    type: "text",
    x: 0,
    y: 0,
    width: 420,
    height: 180,
    color: "6",
    text: [
      `# ${document.title}`,
      "",
      `状态：${document.status}`,
      `ConversationDesignState：${document.conversationDesignStateId} v${document.conversationDesignStateVersion}`,
      `章节：${sections.length}`,
    ].join("\n"),
  });

  let cursorY = -40;
  sections.forEach((section, sectionIndex) => {
    const blocks = sectionBlocks(section);
    const rowHeight = Math.max(220, blocks.length * 150 + 40);
    const sectionId = idFor(document.id, "section", section.id);
    nodes.push({
      id: sectionId,
      type: "text",
      x: 560,
      y: cursorY,
      width: 420,
      height: 170,
      color: colorForSection(section.type, sectionIndex),
      text: sectionNodeText(section, sectionIndex),
    });
    edges.push({
      id: idFor(document.id, "edge", "root", section.id),
      fromNode: rootId,
      fromSide: "right",
      toNode: sectionId,
      toSide: "left",
      toEnd: "arrow",
      label: "章节",
    });

    blocks.forEach((block, blockIndex) => {
      const blockId = idFor(document.id, "block", section.id, block.id);
      nodes.push({
        id: blockId,
        type: "text",
        x: 1120,
        y: cursorY + blockIndex * 150,
        width: 420,
        height: 120,
        color: colorForBlock(block.type),
        text: blockNodeText(block, blockIndex),
      });
      edges.push({
        id: idFor(document.id, "edge", section.id, block.id),
        fromNode: sectionId,
        fromSide: "right",
        toNode: blockId,
        toSide: "left",
        toEnd: "arrow",
        label: block.type,
      });
    });

    cursorY += rowHeight;
  });

  return { nodes, edges };
}

function sectionNodeText(section: RequirementDocSection, index: number) {
  return [
    `## ${index + 1}. ${section.title}`,
    "",
    compactText(section.content, 220),
    section.sourcePaths.length ? `\nsourcePaths：${section.sourcePaths.join(" / ")}` : "",
  ].filter(Boolean).join("\n");
}

function blockNodeText(block: RequirementDocBlock, index: number) {
  const title = block.type === "bullet_list" ? "列表" : block.type;
  return [
    `### ${index + 1}. ${title}`,
    "",
    compactText(block.content, 260),
  ].join("\n");
}

function sectionBlocks(section: RequirementDocSection): RequirementDocBlock[] {
  if (section.blocks?.length) return section.blocks;
  return splitParagraphs(section.content).map((content, index) => ({
    id: `${section.id}:paragraph:${index + 1}`,
    type: "paragraph",
    content,
    sourcePaths: section.sourcePaths,
    tags: section.tags,
  }));
}

function splitParagraphs(content: string) {
  return content
    .split(/\n{2,}|\n(?=\d+\.|[-*]\s+)/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function colorForSection(type: string, index: number) {
  const map: Record<string, string> = {
    overview: "6",
    business_goal: "4",
    target_users: "5",
    user_scenarios: "5",
    page_requirements: "2",
    frontend_rules: "3",
    business_rules: "1",
    state_rules: "4",
    exception_scenarios: "1",
    acceptance_criteria: "4",
  };
  return map[type] ?? String((index % 6) + 1);
}

function colorForBlock(type: RequirementDocBlock["type"]) {
  if (type === "warning") return "2";
  if (type === "info") return "5";
  if (type === "quote") return "6";
  if (type === "table") return "3";
  return "4";
}

function buildCanvasExport(view: DocumentCanvasView): CanvasExportArtifact {
  const json = JSON.stringify(view.canvas, null, 2);
  const buffer = Buffer.from(json, "utf8");
  return {
    format: "prd_canvas",
    conversationId: view.conversationId,
    title: view.title,
    sourceType: "requirement_document",
    sourceId: view.documentId,
    conversationDesignStateId: view.conversationDesignStateId,
    conversationDesignStateVersion: view.conversationDesignStateVersion,
    fileName: `${safeFileName(view.title || "prd")}.canvas`,
    contentType: "application/json; charset=utf-8",
    downloadPath: `/api/conversations/${view.conversationId}/export/canvas`,
    sizeBytes: buffer.byteLength,
    generatedAt: view.generatedAt,
    buffer,
  };
}

function validateJsonCanvas(canvas: JsonCanvasDocument) {
  const ids = new Set<string>();
  for (const node of canvas.nodes) {
    if (ids.has(node.id)) throw new BadRequestException("CANVAS_DUPLICATE_ID");
    ids.add(node.id);
    if (!node.id || !node.type || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      throw new BadRequestException("CANVAS_NODE_INVALID");
    }
    if (node.type === "text" && !node.text) throw new BadRequestException("CANVAS_TEXT_NODE_EMPTY");
  }
  for (const edge of canvas.edges) {
    if (ids.has(edge.id)) throw new BadRequestException("CANVAS_DUPLICATE_ID");
    ids.add(edge.id);
    if (!canvas.nodes.some((node) => node.id === edge.fromNode)) {
      throw new BadRequestException("CANVAS_EDGE_FROM_INVALID");
    }
    if (!canvas.nodes.some((node) => node.id === edge.toNode)) {
      throw new BadRequestException("CANVAS_EDGE_TO_INVALID");
    }
  }
}

function compactText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized || "暂无内容";
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function idFor(...parts: string[]) {
  return createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 16);
}

function safeFileName(value: string) {
  const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  return (normalized || "prd-canvas").slice(0, 80);
}
