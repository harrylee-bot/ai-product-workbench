import { Buffer } from "node:buffer";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import type {
  ExportArtifactSummary,
  ProductDesignState,
  PrototypeArtifact,
  RequirementDocBlock,
  RequirementDocument,
} from "./ai-vibe.types";
import { PrototypeService, validateHtmlSafety } from "./prototype.service";
import { QaService } from "./qa.service";
import { RequirementDocumentService } from "./requirement-document.service";

export type ExportArtifact = ExportArtifactSummary & {
  buffer: Buffer;
};

@Injectable()
export class ExportService {
  constructor(
    private readonly documentService: RequirementDocumentService,
    private readonly prototypeService: PrototypeService,
    private readonly qaService: QaService,
  ) {}

  async exportPrdWordForUser(user: AuthenticatedUser, projectId: string) {
    const current = await this.documentService.getCurrentForUser(user, projectId);
    if (!current.document) throw new NotFoundException("PRD_EXPORT_NOT_FOUND");
    const qaGate = await this.qaService.assertGateAllows(user, projectId, "export_or_publish");
    return this.buildPrdWordExport(current.document, current.productDesignState ?? undefined, qaGate);
  }

  async exportPrototypeHtmlForUser(user: AuthenticatedUser, projectId: string) {
    const current = await this.prototypeService.getCurrentForUser(user, projectId);
    if (!current.artifact) throw new NotFoundException("HTML_EXPORT_NOT_FOUND");
    const qaGate = await this.qaService.assertGateAllows(user, projectId, "export_or_publish");
    return this.buildPrototypeHtmlExport(current.artifact, qaGate);
  }

  async createPrdWordExport(projectId: string) {
    const current = await this.documentService.getCurrentForProject(projectId);
    if (!current.document) throw new NotFoundException("PRD_EXPORT_NOT_FOUND");
    const qaGate = await this.qaService.assertGateAllowsForProject(projectId, "export_or_publish");
    return this.buildPrdWordExport(current.document, current.productDesignState ?? undefined, qaGate);
  }

  async createPrototypeHtmlExport(projectId: string) {
    const current = await this.prototypeService.getCurrentForProject(projectId);
    if (!current.artifact) throw new NotFoundException("HTML_EXPORT_NOT_FOUND");
    const qaGate = await this.qaService.assertGateAllowsForProject(projectId, "export_or_publish");
    return this.buildPrototypeHtmlExport(current.artifact, qaGate);
  }

  private buildPrdWordExport(
    document: RequirementDocument,
    state?: ProductDesignState,
    qaGate?: ExportArtifactSummary["qaGate"],
  ): ExportArtifact {
    const html = renderRequirementDocumentAsWordHtml(document, state);
    const buffer = Buffer.from(`\ufeff${html}`, "utf8");
    const fileName = `${safeFileName(document.title || state?.title || "prd")}.doc`;
    return {
      format: "prd_word",
      projectId: document.projectId,
      title: document.title,
      sourceType: "requirement_document",
      sourceId: document.id,
      productDesignStateId: document.productDesignStateId,
      productDesignStateVersion: document.productDesignStateVersion,
      fileName,
      contentType: "application/msword; charset=utf-8",
      downloadPath: `/api/projects/${document.projectId}/export/word`,
      sizeBytes: buffer.byteLength,
      qaGate,
      generatedAt: new Date().toISOString(),
      buffer,
    };
  }

  private buildPrototypeHtmlExport(
    artifact: PrototypeArtifact,
    qaGate?: ExportArtifactSummary["qaGate"],
  ): ExportArtifact {
    if (artifact.status !== "ready" || !artifact.htmlContent) {
      throw new BadRequestException("PROTOTYPE_EXPORT_NOT_READY");
    }
    const safety = validateHtmlSafety(artifact.htmlContent);
    if (!safety.ok) throw new BadRequestException("PROTOTYPE_HTML_UNSAFE");

    const buffer = Buffer.from(artifact.htmlContent, "utf8");
    const fileName = `${safeFileName(artifact.title || "prototype")}.html`;
    return {
      format: "prototype_html",
      projectId: artifact.projectId,
      title: artifact.title,
      sourceType: "prototype_artifact",
      sourceId: artifact.id,
      productDesignStateId: artifact.productDesignStateId,
      productDesignStateVersion: artifact.productDesignStateVersion,
      fileName,
      contentType: "text/html; charset=utf-8",
      downloadPath: `/api/projects/${artifact.projectId}/export/html`,
      sizeBytes: buffer.byteLength,
      qaGate,
      generatedAt: new Date().toISOString(),
      buffer,
    };
  }
}

export function renderRequirementDocumentAsWordHtml(
  document: RequirementDocument,
  state?: ProductDesignState,
) {
  const sections = [...document.sections].sort((left, right) => left.order - right.order);
  const stateMeta = state
    ? `<p class="meta">ProductDesignState：${escapeHtml(state.id)} v${state.version}</p>`
    : "";
  return [
    "<!doctype html>",
    '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="zh-CN">',
    "<head>",
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />',
    `<title>${escapeHtml(document.title)}</title>`,
    "<style>",
    "@page { size: A4; margin: 24mm 22mm; }",
    "body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif; color: #111827; line-height: 1.65; }",
    "h1 { font-size: 24pt; margin: 0 0 12pt; }",
    "h2 { font-size: 16pt; margin: 20pt 0 8pt; border-bottom: 1px solid #d1d5db; padding-bottom: 4pt; }",
    "h3 { font-size: 13pt; margin: 14pt 0 6pt; }",
    "p { margin: 0 0 8pt; }",
    "ul { margin: 0 0 8pt 20pt; padding: 0; }",
    ".meta { color: #6b7280; font-size: 9pt; }",
    ".block-warning { border-left: 4px solid #f59e0b; padding-left: 8pt; color: #92400e; }",
    ".block-info { border-left: 4px solid #2563eb; padding-left: 8pt; color: #1e40af; }",
    "</style>",
    "</head>",
    "<body>",
    `<h1>${escapeHtml(document.title)}</h1>`,
    `<p class="meta">PRD：${escapeHtml(document.id)} · 状态：${escapeHtml(document.status)} · 更新：${escapeHtml(document.updatedAt)}</p>`,
    stateMeta,
    sections.map(renderSection).join("\n"),
    "</body>",
    "</html>",
  ].join("\n");
}

function renderSection(section: RequirementDocument["sections"][number]) {
  const headingLevel = Math.min(Math.max(section.level + 1, 2), 3);
  const heading = `<h${headingLevel}>${escapeHtml(section.order)}. ${escapeHtml(section.title)}</h${headingLevel}>`;
  const content = renderParagraphs(section.content);
  const blocks = (section.blocks ?? []).map(renderBlock).join("\n");
  return `<section>${heading}${content}${blocks}</section>`;
}

function renderBlock(block: RequirementDocBlock) {
  if (block.type === "bullet_list") {
    const items = splitLines(block.content).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `<ul>${items}</ul>`;
  }
  const className = block.type === "warning"
    ? ' class="block-warning"'
    : block.type === "info"
      ? ' class="block-info"'
      : "";
  return `<p${className}>${escapeHtml(block.content)}</p>`;
}

function renderParagraphs(content: string) {
  const paragraphs = splitLines(content);
  if (!paragraphs.length) return "<p>暂无内容</p>";
  return paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n");
}

function splitLines(value: string) {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeFileName(value: string) {
  const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  return (normalized || "export").slice(0, 80);
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
