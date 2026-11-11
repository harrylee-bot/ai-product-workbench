import {
  prdChannelLabels,
  prdDocumentSchema,
  prdBusinessSections,
  prdSafetyBaselineItems,
  prdSectionKeys,
  type ArtifactVersionDetail,
  type PrdBlock,
  type PrdDocument,
  type PrdDocumentV1,
  type PrdDocumentV2,
  type PrdTemplateDocument,
  type PrdInline,
  type PrototypeDocument,
} from "@workbench/workbench-contracts";

export const artifactVersionComparisonByteLimit = 1_000_000;

export type ArtifactVersionProjection = {
  note: string | null;
  text: string;
};

export function artifactVersionNeedsBlobText(version: ArtifactVersionDetail | undefined): boolean {
  return Boolean(
    version?.contentMode === "blob"
    && ["prd", "code", "document", "data"].includes(version.kind),
  );
}

export async function readArtifactVersionBlobText(blob: Blob): Promise<string> {
  const text = await blob.slice(0, artifactVersionComparisonByteLimit).text();
  const normalized = normalizeLineEndings(text);
  return blob.size > artifactVersionComparisonByteLimit
    ? `${normalized}\n\n[比较内容已截断至前 ${artifactVersionComparisonByteLimit} 字节]`
    : normalized;
}

export function projectArtifactVersion(
  version: ArtifactVersionDetail,
  blobText?: string,
): ArtifactVersionProjection {
  if (version.contentMode === "blob") {
    if (version.kind === "prototype") {
      return {
        note: "该原型版本是二进制内容，只比较可验证的版本元数据，不是像素差异。",
        text: projectBlobMetadata(version),
      };
    }
    if (version.kind === "image") {
      return {
        note: "图片版本只比较可验证的文件元数据，不是像素差异。",
        text: projectBlobMetadata(version),
      };
    }
    if (blobText === undefined) {
      throw new Error(`ArtifactVersion ${version.artifactVersionId} bytes are required for comparison`);
    }
    if (version.kind === "prd") {
      const parsed = parsePrdBlob(blobText);
      return parsed
        ? { note: null, text: projectPrdDocument(parsed) }
        : { note: "该 PRD 未使用结构化 JSON，按原始文本比较。", text: blobText };
    }
    return { note: null, text: blobText };
  }

  if (version.kind === "prd") {
    return { note: null, text: projectPrdDocument(version.content) };
  }
  if (version.kind === "prototype" && version.schemaVersion === 2) {
    const document = version.content;
    return {
      note: "源码原型比较展示原始文件和构建摘要，不包含编译后的脚本。",
      text: [
        `# ${document.title}`, `Revision: ${document.revision}`, document.summary,
        `Entry: ${document.entryFile}`,
        ...document.pages.map((page) => `Page: ${page.id} | ${page.name} | ${page.route}`),
        ...[...document.files].sort((a, b) => a.path.localeCompare(b.path)).flatMap((file) => [`\n## ${file.path}`, file.content]),
        `Source SHA-256: ${document.build.sourceChecksum}`, `Preview SHA-256: ${document.build.htmlSha256}`,
      ].join("\n"),
    };
  }
  if (version.kind === "prototype" && version.schemaVersion === 1) {
    return {
      note: "原型比较展示 screens、nodes、states、actions、bindings、motions、tokens 和 assets 的结构摘要，不是像素差异。",
      text: projectPrototypeSummary(version.content),
    };
  }
  if (version.kind === "code") {
    return { note: null, text: projectPreferredText(version.content, ["code", "source", "text", "content"]) };
  }
  if (version.kind === "document") {
    return { note: null, text: projectPreferredText(version.content, ["markdown", "body", "text", "content"]) };
  }
  return {
    note: version.kind === "image" ? "图片版本展示结构化元数据，不是像素差异。" : null,
    text: stableJson(version.content),
  };
}

export function artifactVersionPinCompatibility(
  reference: { artifactId: string; screenId?: string },
  version: ArtifactVersionDetail | undefined,
): { allowed: boolean; reason: string | null } {
  if (!version) return { allowed: false, reason: "版本内容尚未加载" };
  if (version.artifactId !== reference.artifactId) {
    return { allowed: false, reason: "该版本不属于当前产物" };
  }
  if (version.status !== "ready") {
    return { allowed: false, reason: "只有已就绪版本可以固定到画布" };
  }
  if (!reference.screenId) return { allowed: true, reason: null };
  if (version.kind !== "prototype" || version.schemaVersion !== 1 || version.contentMode !== "inline") {
    return { allowed: false, reason: "无法验证该版本是否包含当前画布界面" };
  }
  if (!version.content.screens.some((screen) => screen.id === reference.screenId)) {
    return { allowed: false, reason: "该版本不包含当前画布界面" };
  }
  return { allowed: true, reason: null };
}

function parsePrdBlob(value: string): PrdDocument | null {
  try {
    const parsed = prdDocumentSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function projectPrdDocument(document: PrdDocument): string {
  return document.protocol !== "workbench.prd.v1"
    ? projectPrdV2Document(document)
    : projectPrdV1Document(document);
}

function projectPrdV1Document(document: PrdDocumentV1): string {
  const lines = [
    `# ${document.title}`,
    "",
    `Revision: ${document.revision.number} (${document.revision.status})`,
    `Summary: ${document.revision.summary}`,
  ];
  for (const [index, key] of prdSectionKeys.entries()) {
    const section = document.sections[key];
    lines.push("", `## ${formatPrdSectionTitle(section.title, index + 1)}`, "");
    for (const block of section.blocks) {
      lines.push(...projectPrdBlock(block), "");
    }
  }
  if (document.assumptions.length > 0) {
    lines.push(
      "## Assumptions",
      "",
      ...document.assumptions.map((assumption) => (
        `- [${assumption.status}/${assumption.impact}] ${assumption.statement}`
      )),
      "",
    );
  }
  if (document.citations.length > 0) {
    lines.push("## Citations", "");
    for (const citation of document.citations) {
      lines.push(`- [${citation.id}] ${citation.title} | ${citation.sourcePath} | ${citation.quote}`);
    }
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd();
}

function projectPrdV2Document(document: PrdTemplateDocument): string {
  const { businessRequirements, degradation, introduction, safetyBaseline } = document.sections;
  const lines = [
    `# ${document.cover.title}`,
    "",
    `工单名称：${document.cover.workOrderName}`,
    `文档版本：V${document.revision.number}`,
    `文档状态：${prdRevisionStatusLabel(document.revision.status)}`,
    `修订时间：${document.revision.changedAt.slice(0, 10)}`,
    `修订摘要：${document.revision.summary}`,
    "",
    "## 版 本 历 史",
    "",
    ...projectMarkdownTable(
      ["版本/状态", "作者", "参与者", "起止日期", "备注"],
      document.versionHistory.map((entry) => [
        entry.status,
        entry.author,
        entry.participants.join("、"),
        `${entry.startDate} 至 ${entry.endDate}`,
        entry.notes,
      ]),
    ),
    "",
    `## ${document.tableOfContents.title}`,
    "",
    ...document.tableOfContents.entries,
    "",
    `## ${introduction.title}`,
  ];
  appendPrdV2Section(lines, introduction.background);
  appendPrdV2Section(lines, introduction.scope);
  appendPrdV2Section(lines, introduction.usageScenarios);
  lines.push(
    "",
    `#### ${introduction.usageScenarios.channelTable.title}`,
    "",
    ...projectMarkdownTable(
      ["序号", "活动投放的可选渠道", "是否投放"],
      introduction.usageScenarios.channelTable.rows.map((row) => [
        String(row.sequence),
        prdChannelLabels[row.channel],
        row.enabled ? "☑是 □否" : "□是 ☑否",
      ]),
    ),
    "",
    `## ${businessRequirements.title}`,
    "",
    projectPrdInline(businessRequirements.summary),
  );
  for (const section of prdBusinessSections(document)) {
    appendPrdV2Section(lines, section);
    for (const diagram of "diagrams" in section ? section.diagrams ?? [] : []) {
      const nodeLabels = new Map(diagram.nodes.map((node) => [node.id, node.label]));
      lines.push(
        "",
        `#### ${diagram.title}`,
        "",
        diagram.description,
        "",
        "节点：",
        ...diagram.nodes.map((node) => `- ${node.label}${node.group ? `（${node.group}）` : ""}`),
        "",
        "节点关系：",
        ...diagram.edges.map((edge) => (
          `- ${nodeLabels.get(edge.from) ?? edge.from} -> ${nodeLabels.get(edge.to) ?? edge.to}${edge.label ? `：${edge.label}` : ""}`
        )),
      );
    }
  }
  lines.push(
    "",
    `## ${degradation.title}`,
    "",
    `是否适用：${degradation.applicable ? "是" : "不涉及"}`,
    projectPrdInline(degradation.content),
    "",
    `## ${safetyBaseline.title}`,
    "",
    safetyBaseline.intro,
    "",
    ...projectMarkdownTable(
      ["序号", "需求安全基线内容", "范围", "是否涉及", "备注"],
      safetyBaseline.rows.flatMap((row, index) => {
        const baseline = prdSafetyBaselineItems[index];
        return baseline ? [[
          String(baseline.sequence),
          baseline.requirement,
          baseline.scope,
          row.applicability,
          row.remarks ?? "-",
        ]] : [];
      }),
    ),
  );
  if (document.assumptions.length > 0) {
    lines.push(
      "",
      "## 假设清单",
      "",
      ...document.assumptions.map((assumption) => (
        `- [${assumption.status}/${assumption.impact}] ${assumption.statement}`
      )),
    );
  }
  if (document.citations.length > 0) {
    lines.push("", "## 引用依据", "");
    for (const citation of document.citations) {
      lines.push(`- [${citation.id}] ${citation.title} | ${citation.sourcePath} | ${citation.quote}`);
    }
  }
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trimEnd();
}

type PrdV2ProjectionSection =
  | PrdDocumentV2["sections"]["introduction"]["background"]
  | PrdDocumentV2["sections"]["introduction"]["scope"]
  | PrdDocumentV2["sections"]["introduction"]["usageScenarios"]
  | PrdDocumentV2["sections"]["businessRequirements"]["pageLinks"]
  | PrdDocumentV2["sections"]["businessRequirements"]["coreRules"]
  | PrdDocumentV2["sections"]["businessRequirements"]["flowAndPages"]
  | PrdDocumentV2["sections"]["businessRequirements"]["acceptanceCriteria"]
  | PrdDocumentV2["sections"]["businessRequirements"]["additionalSections"][number];

function appendPrdV2Section(lines: string[], section: PrdV2ProjectionSection) {
  lines.push("", `### ${section.title}`, "");
  for (const block of section.blocks) lines.push(...projectPrdBlock(block), "");
}

function projectMarkdownTable(headers: readonly string[], rows: readonly (readonly string[])[]) {
  return [
    `| ${headers.map(projectMarkdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(projectMarkdownCell).join(" | ")} |`),
  ];
}

function projectMarkdownCell(value: string) {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}

function formatPrdSectionTitle(title: string, sectionNumber: number) {
  return /^\s*\d+(?:\.\d+)*(?:[.)、]|\s|(?=[\u3400-\u9fff]))/u.test(title)
    ? title
    : `${sectionNumber}. ${title}`;
}

function prdRevisionStatusLabel(status: PrdDocument["revision"]["status"]) {
  if (status === "approved") return "已批准";
  if (status === "inReview") return "评审中";
  return "草稿";
}

function projectPrdBlock(block: PrdBlock): string[] {
  switch (block.type) {
    case "paragraph":
      return [projectPrdInline(block.content)];
    case "heading":
      return [`${"#".repeat(block.level)} ${projectPrdInline(block.content)}`];
    case "bulletList":
      return block.items.map((item) => `- ${projectPrdInline(item.content)}`);
    case "orderedList":
      return block.items.map((item, index) => `${index + 1}. ${projectPrdInline(item.content)}`);
    case "goal":
      return [
        `Goal: ${block.title}`,
        projectPrdInline(block.description),
        `Priority: ${block.priority}`,
        `Success metric: ${block.successMetric}`,
      ];
    case "requirement":
      return [
        `Requirement: ${block.title}`,
        projectPrdInline(block.description),
        `Priority: ${block.priority}`,
        `Goals: ${block.goalIds.join(", ")}`,
        `Acceptance criteria: ${block.acceptanceCriterionIds.join(", ")}`,
      ];
    case "persona":
      return [
        `Persona: ${block.name}`,
        projectPrdInline(block.description),
        `Needs: ${block.needs.join(" | ")}`,
        `Pain points: ${block.painPoints.join(" | ")}`,
      ];
    case "acceptanceCriterion":
      return [
        `前置条件：${projectPrdInline(block.given)}`,
        `触发操作：${projectPrdInline(block.when)}`,
        `预期结果：${projectPrdInline(block.then)}`,
        `Requirements: ${block.requirementIds.join(", ")}`,
      ];
    case "flow":
      return [
        `Flow: ${block.title}`,
        `Actor: ${block.actor}`,
        `Trigger: ${block.trigger}`,
        ...block.steps.map((step, index) => `${index + 1}. ${step.text}`),
        `Outcome: ${block.outcome}`,
      ];
    case "risk":
      return [
        `Risk: ${projectPrdInline(block.description)}`,
        `Likelihood: ${block.likelihood}`,
        `Impact: ${block.impact}`,
        `缓解措施：${projectPrdInline(block.mitigation)}`,
      ];
    case "callout":
      return [
        block.title ? `Callout: ${block.title}` : "Callout",
        projectPrdInline(block.content),
      ];
    case "table":
      return [
        `| ${block.columns.map((column) => column.label).join(" | ")} |`,
        `| ${block.columns.map(() => "---").join(" | ")} |`,
        ...block.rows.map((row) => `| ${block.columns.map((column) => {
          const cell = row.cells.find((candidate) => candidate.columnId === column.id);
          return cell ? projectPrdInline(cell.content) : "";
        }).join(" | ")} |`),
      ];
  }
}

function projectPrdInline(inlines: readonly PrdInline[]): string {
  return inlines.map((inline) => {
    if (inline.type === "text" || inline.type === "link") return inline.text;
    if (inline.type === "citation") return inline.label ?? `[${inline.citationId}]`;
    return inline.label ?? `[${inline.targetType}:${inline.targetId}]`;
  }).join("");
}

function projectPrototypeSummary(document: PrototypeDocument): string {
  return [
    `Protocol: ${document.protocol}`,
    `Document: ${document.documentId}`,
    `Title: ${document.title}`,
    `Revision: ${document.revision}`,
    "",
    `Screens (${document.screens.length})`,
    ...document.screens.map((screen) => (
      `- ${screen.id} | ${screen.name} | ${screen.route} | ${screen.viewport.width}x${screen.viewport.height} | root=${screen.rootNodeId} | initialState=${screen.initialStateId ?? "none"}`
    )),
    "",
    `Nodes (${document.nodes.length}): ${document.nodes.map((node) => `${node.id}:${node.kind}`).join(", ")}`,
    `States (${document.states.length}): ${document.states.map((state) => `${state.id}:${state.screenId}:${state.name}`).join(", ")}`,
    `Actions (${document.actions.length}): ${document.actions.map((action) => `${action.id}:${action.kind}:${action.event}`).join(", ")}`,
    `Bindings (${document.bindings.length}): ${document.bindings.map((binding) => binding.id).join(", ")}`,
    `Motions (${document.motions.length}): ${document.motions.map((motion) => motion.id).join(", ")}`,
    `Tokens (${document.tokens.length}): ${document.tokens.map((token) => `${token.id}:${token.type}`).join(", ")}`,
    `Assets (${document.assets.length}): ${document.assets.map((asset) => `${asset.id}:${asset.kind}`).join(", ")}`,
  ].join("\n");
}

function projectBlobMetadata(version: Extract<ArtifactVersionDetail, { contentMode: "blob" }>): string {
  return [
    `Kind: ${version.kind}`,
    `Schema version: ${version.schemaVersion}`,
    `Media type: ${version.blob.mediaType}`,
    `File name: ${version.blob.fileName ?? "none"}`,
    `Byte size: ${version.blob.byteSize}`,
    `SHA-256: ${version.blob.sha256}`,
  ].join("\n");
}

function projectPreferredText(value: unknown, preferredKeys: readonly string[]): string {
  if (typeof value === "string") return normalizeLineEndings(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of preferredKeys) {
      if (typeof record[key] === "string") return normalizeLineEndings(record[key]);
    }
  }
  return stableJson(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value), null, 2);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])]),
  );
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}
