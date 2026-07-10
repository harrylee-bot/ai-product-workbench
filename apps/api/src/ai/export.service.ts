import { Buffer } from "node:buffer";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthenticatedUser } from "../auth/auth.types";
import { DocumentCanvasService } from "./document-canvas.service";
import type {
  ExportArtifactSummary,
  ConversationDesignState,
  PrototypeArtifact,
  RequirementDocBlock,
  RequirementDocument,
} from "./ai-vibe.types";
import { PrototypeService, sanitizePrototypeDocumentHtml } from "./prototype.service";
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
    private readonly documentCanvasService: DocumentCanvasService,
  ) {}

  async exportPrdWordForUser(user: AuthenticatedUser, conversationId: string) {
    const current = await this.documentService.getCurrentForUser(user, conversationId);
    if (!current.document) throw new NotFoundException("PRD_EXPORT_NOT_FOUND");
    assertDocumentMatchesState(current.document, current.conversationDesignState ?? undefined);
    const qaGate = await this.qaService.assertGateAllows(user, conversationId, "export_or_publish");
    return this.buildPrdWordExport(current.document, current.conversationDesignState ?? undefined, qaGate);
  }

  async exportPrototypeHtmlForUser(user: AuthenticatedUser, conversationId: string) {
    const current = await this.prototypeService.getCurrentForUser(user, conversationId);
    if (!current.artifact) throw new NotFoundException("HTML_EXPORT_NOT_FOUND");
    assertArtifactMatchesState(current.artifact, current.conversationDesignState ?? undefined);
    const qaGate = await this.qaService.assertGateAllows(user, conversationId, "export_or_publish");
    return this.buildPrototypeHtmlExport(current.artifact, qaGate);
  }

  async exportPrdCanvasForUser(user: AuthenticatedUser, conversationId: string) {
    const qaGate = await this.qaService.assertGateAllows(user, conversationId, "export_or_publish");
    const artifact = await this.documentCanvasService.createCanvasExportForUser(user, conversationId);
    return { ...artifact, qaGate };
  }

  async createPrdWordExport(conversationId: string) {
    const current = await this.documentService.getCurrentForConversation(conversationId);
    if (!current.document) throw new NotFoundException("PRD_EXPORT_NOT_FOUND");
    assertDocumentMatchesState(current.document, current.conversationDesignState ?? undefined);
    const qaGate = await this.qaService.assertGateAllowsForConversation(conversationId, "export_or_publish");
    return this.buildPrdWordExport(current.document, current.conversationDesignState ?? undefined, qaGate);
  }

  async createPrototypeHtmlExport(conversationId: string) {
    const current = await this.prototypeService.getCurrentForConversation(conversationId);
    if (!current.artifact) throw new NotFoundException("HTML_EXPORT_NOT_FOUND");
    assertArtifactMatchesState(current.artifact, current.conversationDesignState ?? undefined);
    const qaGate = await this.qaService.assertGateAllowsForConversation(conversationId, "export_or_publish");
    return this.buildPrototypeHtmlExport(current.artifact, qaGate);
  }

  async createPrdCanvasExport(conversationId: string) {
    const qaGate = await this.qaService.assertGateAllowsForConversation(conversationId, "export_or_publish");
    const artifact = await this.documentCanvasService.createCanvasExportForConversation(conversationId);
    return { ...artifact, qaGate };
  }

  private buildPrdWordExport(
    document: RequirementDocument,
    state?: ConversationDesignState,
    qaGate?: ExportArtifactSummary["qaGate"],
  ): ExportArtifact {
    const html = renderRequirementDocumentAsWordHtml(document, state);
    const buffer = Buffer.from(`\ufeff${html}`, "utf8");
    const exportTitle = getRequirementDocumentExportTitle(document, state);
    const fileName = `${safeFileName(exportTitle)}.doc`;
    return {
      format: "prd_word",
      conversationId: document.conversationId,
      title: exportTitle,
      sourceType: "requirement_document",
      sourceId: document.id,
      conversationDesignStateId: document.conversationDesignStateId,
      conversationDesignStateVersion: document.conversationDesignStateVersion,
      fileName,
      contentType: "application/msword; charset=utf-8",
      downloadPath: `/api/conversations/${document.conversationId}/export/word`,
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
    const htmlContent = sanitizePrototypeDocumentHtml(artifact.htmlContent, artifact.title);
    if (!htmlContent.trim()) throw new BadRequestException("PROTOTYPE_HTML_EMPTY_AFTER_SANITIZE");

    const buffer = Buffer.from(htmlContent, "utf8");
    const fileName = `${safeFileName(artifact.title || "prototype")}.html`;
    return {
      format: "prototype_html",
      conversationId: artifact.conversationId,
      title: artifact.title,
      sourceType: "prototype_artifact",
      sourceId: artifact.id,
      conversationDesignStateId: artifact.conversationDesignStateId,
      conversationDesignStateVersion: artifact.conversationDesignStateVersion,
      fileName,
      contentType: "text/html; charset=utf-8",
      downloadPath: `/api/conversations/${artifact.conversationId}/export/html`,
      sizeBytes: buffer.byteLength,
      qaGate,
      generatedAt: new Date().toISOString(),
      buffer,
    };
  }
}

function assertDocumentMatchesState(document: RequirementDocument, state?: ConversationDesignState) {
  if (!state) return;
  if (document.conversationDesignStateId === state.id && document.conversationDesignStateVersion === state.version) return;
  throw new BadRequestException("PRD_EXPORT_STATE_MISMATCH");
}

function assertArtifactMatchesState(artifact: PrototypeArtifact, state?: ConversationDesignState) {
  if (!state) return;
  if (artifact.conversationDesignStateId === state.id && artifact.conversationDesignStateVersion === state.version) return;
  throw new BadRequestException("HTML_EXPORT_STATE_MISMATCH");
}

function renderRequirementDocumentAsWordHtml(
  document: RequirementDocument,
  state?: ConversationDesignState,
) {
  const sections = [...document.sections].sort((left, right) => left.order - right.order);
  const exportTitle = getRequirementDocumentExportTitle(document, state);
  const workOrderName = exportTitle.replace(/需求说明书$/, "") || "需求";
  const author = document.updatedBy || document.createdBy || state?.updatedBy || state?.createdBy || "待确认";
  const dateText = formatDate(document.updatedAt || state?.updatedAt);
  const introSections = buildIntroSections(sections, document, state);
  const businessSections = buildBusinessSections(sections, document, state);
  const degradation = buildDegradationSection(sections, document, state);
  const safetyRows = buildSafetyBaselineRows(document, state);
  const tocEntries = [
    { number: "1", title: "引言", level: 1 },
    ...introSections.map((section) => ({ number: section.number, title: section.title, level: 2 })),
    { number: "2", title: "业务需求", level: 1 },
    ...businessSections.map((section) => ({ number: section.number, title: section.title, level: 2 })),
    { number: "3", title: "业务降级方案（必填）", level: 1 },
    { number: "4", title: "需求安全基线要求（必填）", level: 1 },
  ];
  const stateMeta = state
    ? `<p class="meta">ConversationDesignState：${escapeHtml(state.id)} v${state.version}</p>`
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
    "h1 { font-size: 24pt; margin: 0 0 12pt; text-align: center; }",
    "h2 { font-size: 16pt; margin: 20pt 0 8pt; color: #1d4ed8; border-bottom: 1px solid #bfdbfe; padding-bottom: 4pt; }",
    "h3 { font-size: 13pt; margin: 14pt 0 6pt; color: #1e40af; }",
    "p { margin: 0 0 8pt; }",
    "ul { margin: 0 0 8pt 20pt; padding: 0; }",
    "table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; table-layout: fixed; }",
    "th, td { border: 1px solid #cbd5e1; padding: 5pt 6pt; vertical-align: top; word-break: break-word; }",
    "th { background: #eff6ff; color: #1e3a8a; font-weight: 600; }",
    ".cover-page { min-height: 230mm; page-break-after: always; display: block; }",
    ".cover-title { margin-top: 72mm; }",
    ".cover-meta { margin-top: 36pt; text-align: center; color: #4b5563; }",
    ".page-break { page-break-after: always; }",
    ".toc-table td:first-child { width: 76pt; color: #1e40af; }",
    ".toc-level-2 td:first-child { padding-left: 18pt; }",
    ".meta { color: #6b7280; font-size: 9pt; }",
    ".block-warning { border-left: 4px solid #f59e0b; padding-left: 8pt; color: #92400e; }",
    ".block-info { border-left: 4px solid #2563eb; padding-left: 8pt; color: #1e40af; }",
    ".block-asset { margin: 10pt 0; padding: 8pt; border: 1px solid #d1d5db; background: #f9fafb; }",
    ".block-asset img { max-width: 100%; height: auto; border: 1px solid #e5e7eb; }",
    ".block-caption { color: #4b5563; font-size: 9pt; margin-top: 4pt; }",
    "pre.diagram { white-space: pre-wrap; background: #f3f4f6; border: 1px solid #d1d5db; padding: 8pt; font-family: Consolas, monospace; font-size: 9pt; }",
    "</style>",
    "</head>",
    "<body>",
    '<section class="cover-page">',
    `<h1 class="cover-title">${escapeHtml(exportTitle)}</h1>`,
    '<div class="cover-meta">',
    `<p>工单名称：${escapeHtml(workOrderName)}</p>`,
    `<p>文档状态：${escapeHtml(document.status)}　更新日期：${escapeHtml(dateText)}</p>`,
    `<p class="meta">PRD：${escapeHtml(document.id)}</p>`,
    stateMeta,
    "</div>",
    "</section>",
    '<section class="page-break">',
    "<h2>版 本 历 史</h2>",
    renderTable(
      ["版本/状态", "作者", "参与者", "起止日期", "备注"],
      [["讨论稿", author, "待确认", dateText, "AI 生成需求说明书，待业务和研发评审确认。"]],
    ),
    "</section>",
    '<section class="page-break">',
    "<h2>目 录</h2>",
    renderTocTable(tocEntries),
    "</section>",
    "<section>",
    "<h2>1 引言</h2>",
    introSections.map(renderExportSection).join("\n"),
    "</section>",
    "<section>",
    "<h2>2 业务需求</h2>",
    `<p>总体目标：${escapeHtml(getBusinessGoal(document, state))}</p>`,
    businessSections.map(renderExportSection).join("\n"),
    "</section>",
    "<section>",
    "<h2>3 业务降级方案（必填）</h2>",
    renderParagraphs(degradation),
    "</section>",
    "<section>",
    "<h2>4 需求安全基线要求（必填）</h2>",
    renderParagraphs(SAFETY_BASELINE_INTRO),
    renderTable(["序号", "需求安全基线内容", "范围", "是否涉及"], safetyRows, "safety-table"),
    "</section>",
    "</body>",
    "</html>",
  ].join("\n");
}

type ExportSection = {
  number: string;
  title: string;
  content?: string;
  html?: string;
  sourceSection?: RequirementDocument["sections"][number];
};

type SafetyBaselineRow = {
  index: string;
  content: string;
  scope: string;
  status: "是" | "否" | "不涉及";
};

const SAFETY_BASELINE_INTRO = [
  "该部分内容为必填项，请按照如下表格中的内容先进行自查，并按照如下要求完善需求文档：",
  "1、如选择“是”，代表本项自查内容已符合安全要求，需要提供截图违依据",
  "2、如选择“否”，代表本项自查内容暂时不符合安全要求，请在需求文档中增加本部分内容安全改造需求，并发送网信安需求评审邮件，附上本需求文档用于安全评审；",
  "3、如选择“不涉及”，代表本项目各项需求安全基线均不涉及，则无需召开网信安需求评审会。",
  "建议：该表格请业务人员和开发人员共同参与自查并填写。",
].join("\n");

const STANDARD_SAFETY_BASELINE_ROWS: SafetyBaselineRow[] = [
  { index: "1", content: "是否有新开发功能接口或现有功能接口逻辑变动", scope: "信息系统（包含前端、后端、管理后台）", status: "是" },
  { index: "2", content: "业务功能是否面向公众用户", scope: "信息系统（包含前端、后端、管理后台）", status: "是" },
  { index: "3", content: "是否涉及新开通公网暴露面", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "4", content: "管理后台涉及个人信息的内容要求脱敏展示，原则上不做非脱敏个人信息的导出功能。", scope: "管理后台", status: "不涉及" },
  { index: "5", content: "管理后台所有操作页面要有水印功能，水印至少包括姓名、手机号、操作时间等信息", scope: "管理后台", status: "不涉及" },
  { index: "6", content: "管理后台涉及查询的页面，不允许没有查询条件查询所有数据，必须输入查询条件后才可以查询数据；", scope: "管理后台", status: "不涉及" },
  { index: "7", content: "管理后台应接入4A统一管理，实现一点注销的功能，不允许有独立的账号体系；按4A要求实现日志留存，并实现风险预警功能；", scope: "管理后台", status: "不涉及" },
  { index: "8", content: "如未接入4A系统统一管理，应满足通行字的18项安全要求；要求细则找安全中心要；", scope: "管理后台", status: "不涉及" },
  { index: "9", content: "涉及后台配置内容的需要实现“敏感词过滤”能力；", scope: "管理后台", status: "不涉及" },
  { index: "10", content: "所有在前台展示的内容如为后台配置显示，均需要执行“先审后发”，1、具备“先审后发”能力，2、同步发布数据；3、内部发布上线和下线都需要经过“先审后发”。", scope: "前台展示", status: "不涉及" },
  { index: "11", content: "是否涉及展示《隐私政策》：新业务场景《隐私政策》或已有《隐私政策》的变更需要进行法务及安全审核；《隐私政策》应为独立的文档，四次点击应能访问到独立的菜单；用户未同意《隐私政策》前，不得获取用户任何信息；", scope: "前端页面", status: "不涉及" },
  { index: "12", content: "如涉及加载到APP或小程序，APP、小程序业务应实现双清单功能，“用户信息收集清单”应动态准实时展现采集的个人信息具体内容；“第三方信息共享清单”应涵盖业务所有涉及到的第三方公司及内容；", scope: "前端展示 / 底层接口获取数据", status: "不涉及" },
  { index: "13", content: "前台页面涉及采集身份证号码、身份证照片、生物识别和银行卡信息时，应再次获取用户的主动授权同意。", scope: "前端页面", status: "不涉及" },
  { index: "14", content: "是否涉及免密登录。免密登录的不能为无感知免密登录，需经过用户同意《数字生活隐私政策》后才可以进行免密登录。", scope: "前端页面", status: "不涉及" },
  { index: "15", content: "是否涉及跳转第三方页面或应用。如涉及，应进行弹窗提示，文案应包含：即将跳转的业务名称、第三方公司名称、传的用户信息用户操作目的及第三方的《隐私政策》相关内容，可参考线上已有弹窗。", scope: "前端页面", status: "不涉及" },
  { index: "16", content: "如涉及与第三方公司接口对接进行数据交互，应先查看对应的《数据使用审批单》无误后，才可以正式上线；", scope: "前台、后台", status: "不涉及" },
  { index: "17", content: "API接口安全管理：如为新增API接口，需完成台账填报；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "18", content: "涉及用户敏感信息或跨系统的API是否采用加密传输，具备接口鉴权、访问控制等措施；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "19", content: "是否涉及用户信息或重要数据存储，是否进行加密存储；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "20", content: "是否涉及数据采集，是否建立数据采集规范，明确数采集方式、渠道、数据格式、采集流程等；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
  { index: "21", content: "是否对采集到的数据进行完整性和一致性校验；", scope: "信息系统（包含前端、后端、管理后台）", status: "不涉及" },
];

function renderExportSection(section: ExportSection) {
  const heading = `<h3>${escapeHtml(section.number)} ${escapeHtml(section.title)}</h3>`;
  const content = section.html ?? renderParagraphs(section.content || section.sourceSection?.content || "");
  const blocks = (section.sourceSection?.blocks ?? []).map(renderBlock).join("\n");
  return `<section>${heading}${content}${blocks}</section>`;
}

function renderBlock(block: RequirementDocBlock) {
  if (block.type === "bullet_list") {
    const items = splitLines(block.content).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `<ul>${items}</ul>`;
  }
  if (block.type === "table") {
    const title = block.title ? `<p><strong>${escapeHtml(block.title)}</strong></p>` : "";
    return `<div class="block-asset">${title}${renderMarkdownTable(block.content) ?? renderParagraphs(block.content)}</div>`;
  }
  if (block.type === "diagram") {
    const title = block.title ? `<p><strong>${escapeHtml(block.title)}</strong></p>` : "";
    const syntax = block.diagramSyntax ?? "mermaid";
    return `<div class="block-asset">${title}<p class="block-caption">图表源码（${escapeHtml(syntax)}）</p><pre class="diagram">${escapeHtml(block.content)}</pre></div>`;
  }
  if (block.type === "image" || block.type === "prototype_snapshot") {
    const title = block.title ? `<p><strong>${escapeHtml(block.title)}</strong></p>` : "";
    const image = block.assetPath
      ? `<img src="${escapeHtml(block.assetPath)}" alt="${escapeHtml(block.title || block.content || "asset")}" />`
      : "";
    const pathText = block.assetPath ? `<p class="block-caption">素材路径：${escapeHtml(block.assetPath)}</p>` : "";
    return `<div class="block-asset">${title}${image}<p>${escapeHtml(block.content)}</p>${pathText}</div>`;
  }
  if (block.type === "asset_reference") {
    return `<div class="block-asset"><p><strong>${escapeHtml(block.title || "素材引用")}</strong></p><p>${escapeHtml(block.content)}</p>${block.assetPath ? `<p class="block-caption">素材路径：${escapeHtml(block.assetPath)}</p>` : ""}</div>`;
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
  return paragraphs.map((paragraph) => {
    const table = renderMarkdownTable(paragraph);
    return table ?? `<p>${escapeHtml(paragraph)}</p>`;
  }).join("\n");
}

function splitLines(value: string) {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderTable(headers: string[], rows: string[][], className = "standard-table") {
  const headerHtml = `<tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>`;
  const rowClass = className === "safety-table" ? ' class="safety-row"' : "";
  const bodyHtml = rows
    .map((row) => `<tr${rowClass}>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="${escapeHtml(className)}"><thead>${headerHtml}</thead><tbody>${bodyHtml}</tbody></table>`;
}

function renderTocTable(entries: Array<{ number: string; title: string; level: number }>) {
  const rows = entries.map((entry) => {
    const className = entry.level > 1 ? ' class="toc-level-2"' : "";
    return `<tr${className}><td>${escapeHtml(entry.number)}</td><td>${escapeHtml(entry.title)}</td></tr>`;
  }).join("");
  return `<table class="toc-table"><tbody>${rows}</tbody></table>`;
}

function renderMarkdownTable(markdown: string) {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("|"));
  if (lines.length < 2) return undefined;
  const rows = lines.map(parseMarkdownTableRow).filter((row) => row.length > 1);
  if (rows.length < 2) return undefined;
  const hasSeparator = rows[1].every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s+/g, "")));
  const headers = rows[0];
  const bodyRows = hasSeparator ? rows.slice(2) : rows.slice(1);
  if (!bodyRows.length) return undefined;
  return renderTable(headers, bodyRows);
}

function parseMarkdownTableRow(line: string) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function buildIntroSections(
  sections: RequirementDocument["sections"],
  document: RequirementDocument,
  state?: ConversationDesignState,
): ExportSection[] {
  const background = findSection(sections, (section) => section.type === "background" || /背景|项目背景/.test(section.title));
  const scope = findSection(sections, (section) => section.type === "scope" || /范围|文档范围/.test(section.title));
  const scenario = findSection(sections, (section) => section.type === "user_scenarios" || /使用场景|用户场景/.test(section.title));
  return [
    {
      number: "1.1",
      title: "项目背景",
      content: background?.content || buildBackgroundFallback(document, state),
      sourceSection: background,
    },
    {
      number: "1.2",
      title: "文档范围",
      html: renderScope(scope, document, state),
    },
    {
      number: "1.3",
      title: "使用场景（必填）",
      html: [
        renderParagraphs(scenario?.content || buildScenarioFallback(document, state)),
        renderTable(["序号", "活动投放的可选渠道", "是否投放"], buildChannelRows(document, state)),
      ].join("\n"),
      sourceSection: scenario,
    },
  ];
}

function buildBusinessSections(
  sections: RequirementDocument["sections"],
  document: RequirementDocument,
  state?: ConversationDesignState,
): ExportSection[] {
  const used = new Set<string>();
  const pageLink = findSection(sections, (section) => /页面链接|页面入口/.test(section.title));
  if (pageLink) used.add(pageLink.id);
  const interfaceSection = findSection(sections, (section) =>
    section.type === "backend_configs" || /接口|API|能力调用|新增\/修改/.test(section.title),
  );
  if (interfaceSection) used.add(interfaceSection.id);
  const acceptance = findSection(sections, (section) => section.type === "acceptance_criteria" || /验收/.test(section.title));
  if (acceptance) used.add(acceptance.id);

  const coreSections = sections
    .filter((section) => !used.has(section.id))
    .filter((section) => !isIntroOrAppendixSection(section))
    .filter((section) => (section.content || "").trim() || (section.blocks?.length ?? 0) > 0)
    .slice(0, 8);

  const result: ExportSection[] = [
    {
      number: "2.1",
      title: "页面链接",
      html: renderPageLinks(pageLink, document, state),
      sourceSection: pageLink,
    },
  ];

  if (coreSections.length) {
    coreSections.forEach((section, index) => {
      result.push({
        number: `2.${index + 2}`,
        title: cleanHeadingTitle(section.title) || `核心业务规则/功能说明 ${index + 1}`,
        sourceSection: section,
      });
    });
  } else {
    result.push({
      number: "2.2",
      title: "核心业务规则/功能说明",
      html: renderCoreRulesFallback(document, state),
    });
  }

  result.push({
    number: `2.${result.length + 1}`,
    title: "验收标准",
    html: renderAcceptanceTable(acceptance, document, state),
    sourceSection: acceptance,
  });
  return result;
}

function renderScope(
  source: RequirementDocument["sections"][number] | undefined,
  document: RequirementDocument,
  state?: ConversationDesignState,
) {
  const items = splitLines(source?.content ?? "")
    .map(stripListPrefix)
    .filter(Boolean);
  if (!items.length) {
    items.push(...compactRecordItems(state?.pages, "页面"));
    items.push(...compactRecordItems(state?.backendConfigs, "后台配置"));
    items.push(...compactRecordItems(state?.frontendRules, "前端规则"));
    items.push(...compactRecordItems(state?.businessRules, "业务规则"));
  }
  const fallback = items.length
    ? items
    : [
        `${getRequirementBaseName(document, state)}相关页面、配置项、业务流程、验收标准、降级方案和安全基线。`,
        "具体上线范围以业务评审、技术方案和联调结果为准。",
      ];
  return `<ul>${fallback.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderPageLinks(
  source: RequirementDocument["sections"][number] | undefined,
  document: RequirementDocument,
  state?: ConversationDesignState,
) {
  const sourceContent = source?.content?.trim();
  const pageItems = compactRecordItems(state?.pages, "页面");
  const items = sourceContent
    ? splitLines(sourceContent).map(stripListPrefix)
    : [
        pageItems[0] || `${getRequirementBaseName(document, state)}相关页面入口以活动配置平台实际菜单和上线地址为准。`,
        "页面 URL / 路由：以实际上线地址为准。",
        "页面需要承载本需求的配置、查询、展示、跳转或结果反馈能力，不能只依赖链接说明。",
      ];
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderCoreRulesFallback(document: RequirementDocument, state?: ConversationDesignState) {
  const rows = [
    ...compactRecordItems(state?.features, "功能点"),
    ...compactRecordItems(state?.businessRules, "业务规则"),
    ...compactRecordItems(state?.stateRules, "状态规则"),
    ...document.sections
      .filter((section) => (section.content || "").trim())
      .map((section) => `${cleanHeadingTitle(section.title) || "需求说明"}：${section.content.trim()}`),
  ];
  if (!rows.length) {
    rows.push(`${getRequirementBaseName(document, state)}需按业务配置完成展示、提交、查询、状态变更和结果反馈。`);
  }
  return renderTable(
    ["功能点", "业务规则", "页面要求"],
    rows.slice(0, 8).map((item) => [
      item,
      "需明确触发条件、前置校验、成功结果、失败处理、重复操作规则和数据记录口径。",
      "页面需展示当前状态、可执行动作、必填校验、异常提示和处理入口。",
    ]),
  );
}

function renderAcceptanceTable(
  source: RequirementDocument["sections"][number] | undefined,
  document: RequirementDocument,
  state?: ConversationDesignState,
) {
  const sourceContent = source?.content?.trim();
  if (sourceContent) {
    const table = renderMarkdownTable(sourceContent);
    if (table) return table;
    const rows = splitLines(sourceContent).map((item, index) => [String(index + 1), cleanAcceptanceTitle(item), stripListPrefix(item)]);
    return renderTable(["序号", "验收项", "验收标准"], rows);
  }
  const base = getRequirementBaseName(document, state);
  return renderTable(
    ["序号", "验收项", "验收标准"],
    [
      ["1", "页面可见性", `${base}相关入口、页面标题、配置项和结果展示符合评审确认范围。`],
      ["2", "业务规则", "配置保存、查询、状态流转、重复操作、空态和异常提示均符合需求规则。"],
      ["3", "异常处理", "失败、超时和无权限场景均有明确页面提示、状态记录和后续处理方式。"],
      ["4", "存量影响", "存量活动、存量配置和历史页面不受本需求影响，新增能力可按权限和配置开关控制。"],
    ],
  );
}

function buildDegradationSection(
  sections: RequirementDocument["sections"],
  document: RequirementDocument,
  state?: ConversationDesignState,
) {
  const source = findSection(sections, (section) => /降级/.test(section.title))
    ?? findSection(sections, (section) => section.type === "exception_scenarios" || /异常|兜底|失败/.test(section.title));
  if (source?.content?.trim()) return source.content;
  const base = getRequirementBaseName(document, state);
  return [
    `如${base}涉及的配置保存、发布审核、查询能力、状态同步或页面跳转出现异常，前台页面应保留当前可用状态并展示明确失败提示，不允许出现空白页、重复提交或错误成功态。`,
    "运营后台应记录失败原因、请求时间、关键配置编号和操作人，支持人工核对后重试或回滚到上一版已生效配置。",
    "下游系统或活动页面不可用时，平台应暂停继续发布或标记为待处理，待接口恢复后由运营重新触发同步，确保用户可见状态、后台配置状态和交易/活动结果保持一致。",
  ].join("\n");
}

function buildSafetyBaselineRows(document: RequirementDocument, state?: ConversationDesignState) {
  const text = JSON.stringify({ title: document.title, sections: document.sections, state }).toLowerCase();
  const rows = STANDARD_SAFETY_BASELINE_ROWS.map((row) => ({ ...row }));
  const setYes = (...indexes: string[]) => {
    indexes.forEach((index) => {
      const row = rows.find((item) => item.index === index);
      if (row) row.status = "是";
    });
  };

  if (/后台|管理|配置|运营/.test(text)) setYes("5", "6");
  if (/敏感词|后台配置|配置.*展示|前台展示|发布|上线|审核/.test(text)) setYes("9", "10");
  if (/隐私|个人信息|手机号|证件|身份证|银行卡|用户信息/.test(text)) setYes("4", "11", "12", "18", "19");
  if (/身份证|银行卡|生物识别/.test(text)) setYes("13");
  if (/免密|一键登录|登录/.test(text)) setYes("14");
  if (/第三方|外链|跳转.*app|跳转.*应用|跳转.*页面/.test(text)) setYes("15", "16");
  if (/接口|api|回调|联调|调用|新增|修改/.test(text)) setYes("17", "18");
  if (/埋点|采集|统计|pv|uv|快照|交易|数据|报表/.test(text)) setYes("20", "21");
  return rows.map((row) => [row.index, row.content, row.scope, row.status]);
}

function getRequirementDocumentExportTitle(document: RequirementDocument, state?: ConversationDesignState) {
  return `${getRequirementBaseName(document, state)}需求说明书`;
}

function getRequirementBaseName(document: RequirementDocument, state?: ConversationDesignState) {
  const preferred = state?.title || document.title || "需求";
  const normalized = preferred
    .replace(/\s+/g, " ")
    .replace(/(产品需求文档|需求说明书|需求文档|PRD|prd)$/i, "")
    .replace(/[－\-—_ ]+$/g, "")
    .trim();
  return normalized || "需求";
}

function getBusinessGoal(document: RequirementDocument, state?: ConversationDesignState) {
  const goalSection = findSection(document.sections, (section) => section.type === "business_goal" || /目标/.test(section.title));
  return state?.businessGoal || goalSection?.content || state?.summary || `${getRequirementBaseName(document, state)}形成可配置、可验证、可回滚的业务闭环。`;
}

function buildBackgroundFallback(document: RequirementDocument, state?: ConversationDesignState) {
  return state?.background
    || state?.summary
    || `${getRequirementBaseName(document, state)}涉及活动配置平台相关业务能力。本次需求用于补充配置、页面展示、状态联动、结果校验和运营验收口径，支撑业务上线评审与测试用例编写。`;
}

function buildScenarioFallback(document: RequirementDocument, state?: ConversationDesignState) {
  const scenarios = compactRecordItems(state?.userScenarios, "场景");
  return scenarios.length
    ? scenarios.join("；")
    : `运营人员在活动配置平台完成${getRequirementBaseName(document, state)}相关配置，用户或下游系统按配置完成页面访问、结果查询或状态反馈。`;
}

function buildChannelRows(document: RequirementDocument, state?: ConversationDesignState) {
  const text = JSON.stringify({ title: document.title, sections: document.sections, state });
  const inApp = /端内|app|APP|小程序/.test(text) ? "☑是 □否" : "☑是 □否";
  const h5 = /H5|WAP|端外|wap|h5/.test(text) ? "☑是 □否" : "□是 ☑否";
  const mini = /小程序/.test(text) ? "☑是 □否" : "□是 ☑否";
  return [
    ["1", "端内渠道", inApp],
    ["2", "WAP/H5端外渠道", h5],
    ["3", "小程序", mini],
  ];
}

function compactRecordItems(items: unknown, prefix: string) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item, index) => compactRecordItem(item, `${prefix}${index + 1}`))
    .filter(Boolean);
}

function compactRecordItem(item: unknown, fallback: string) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return String(item || "").trim();
  const record = item as Record<string, unknown>;
  const title = [record.name, record.title, record.label, record.id, fallback]
    .map((value) => String(value ?? "").trim())
    .find(Boolean) || fallback;
  const detail = [record.description, record.summary, record.rule, record.content]
    .map((value) => String(value ?? "").trim())
    .find(Boolean);
  return detail ? `${title}：${detail}` : title;
}

function findSection(
  sections: RequirementDocument["sections"],
  predicate: (section: RequirementDocument["sections"][number]) => boolean,
) {
  return sections.find((section) => predicate(section) && ((section.content || "").trim() || (section.blocks?.length ?? 0) > 0));
}

function isIntroOrAppendixSection(section: RequirementDocument["sections"][number]) {
  if (["background", "scope", "target_users", "user_scenarios", "business_goal", "acceptance_criteria", "backend_configs", "exception_scenarios", "assumptions", "knowledge_refs", "pending_questions", "appendix"].includes(section.type)) {
    return true;
  }
  return /^(概览|产品概述|背景|项目背景|范围|文档范围|使用场景|用户场景|验收|接口|API|降级|异常|安全基线|需求安全)/.test(cleanHeadingTitle(section.title));
}

function cleanHeadingTitle(value: string) {
  return value.replace(/^\s*\d+(\.\d+)*[.、]?\s*/, "").trim();
}

function stripListPrefix(value: string) {
  return value.replace(/^\s*[-*•]\s*/, "").replace(/^\s*\d+[.、]\s*/, "").trim();
}

function cleanAcceptanceTitle(value: string) {
  return stripListPrefix(value).replace(/[：:，,。].*$/, "").slice(0, 24) || "验收项";
}

function formatDate(value: string | undefined) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10) || new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
