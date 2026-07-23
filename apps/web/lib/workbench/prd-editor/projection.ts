import type { JSONContent } from "@tiptap/core";
import {
  prdChannelLabels,
  prdSafetyBaselineItems,
  prdSectionKeys,
  type PrdBlock,
  type PrdDocument,
  type PrdDocumentV1,
  type PrdDocumentV2,
  type PrdInline,
} from "@workbench/workbench-contracts";

type PathPart = string | number;
type FieldRole = "body" | "block-title" | "metadata" | "section-title" | "title";
type PrdTextMark = Extract<PrdInline, { type: "text" }>["marks"][number];
type PrdEditableSection = { title: string; blocks: PrdBlock[] };
type PrdSectionProjection = {
  key: string;
  path: readonly PathPart[];
  section: PrdEditableSection;
};

const prdV2TitleSuffix = "需求说明书";

export function prdDocumentToTiptap(document: PrdDocument): JSONContent {
  return document.protocol === "workbench.prd.v2"
    ? prdDocumentV2ToTiptap(document)
    : prdDocumentV1ToTiptap(document);
}

function prdDocumentV1ToTiptap(document: PrdDocumentV1): JSONContent {
  return {
    type: "doc",
    content: [
      stringField(["title"], document.title, "title", "heading", 1, undefined, document.documentId),
      ...v1SectionProjections(document).map((projection, index) => sectionToTiptap(
        projection,
        stringField(
          [...projection.path, "title"],
          projection.section.title,
          "section-title",
          "heading",
          2,
          `${index + 1}. `,
        ),
      )),
    ],
  };
}

function prdDocumentV2ToTiptap(document: PrdDocumentV2): JSONContent {
  const sections = v2SectionProjections(document);
  const byKey = new Map(sections.map((section) => [section.key, section]));
  const section = (key: string, trailing: JSONContent[] = []) => {
    const projection = byKey.get(key);
    if (!projection) throw new Error(`Missing PRD v2 editor section: ${key}`);
    return sectionToTiptap(
      projection,
      fixedBlock(projection.section.title, "subsection-title"),
      trailing,
    );
  };

  return {
    type: "doc",
    content: [
      stringField(["title"], document.title, "title", "heading", 1, undefined, document.documentId),
      fixedBlock(versionHistoryText(document), "table"),
      fixedBlock([
        document.tableOfContents.title,
        ...document.tableOfContents.entries,
      ].join("\n"), "table"),
      fixedBlock(document.sections.introduction.title, "section-title"),
      section("v2:introduction.background"),
      section("v2:introduction.scope"),
      section("v2:introduction.usageScenarios", [
        fixedBlock(channelTableText(document), "table"),
      ]),
      fixedBlock(document.sections.businessRequirements.title, "section-title"),
      inlineField(
        ["sections", "businessRequirements", "summary"],
        document.sections.businessRequirements.summary,
        "body",
      ),
      section("v2:businessRequirements.pageLinks"),
      section("v2:businessRequirements.coreRules"),
      section("v2:businessRequirements.flowAndPages", document.sections.businessRequirements.flowAndPages.diagrams.map((diagram) => (
        fixedBlock(diagramText(diagram), "diagram")
      ))),
      section("v2:businessRequirements.acceptanceCriteria"),
      {
        type: "prdSection",
        attrs: { sectionKey: "v2:degradation", dataId: "section-v2-degradation" },
        content: [
          fixedBlock(document.sections.degradation.title, "section-title"),
          inlineField(
            ["sections", "degradation", "content"],
            document.sections.degradation.content,
            "body",
          ),
        ],
      },
      {
        type: "prdSection",
        attrs: { sectionKey: "v2:safetyBaseline", dataId: "section-v2-safety-baseline" },
        content: [
          fixedBlock(document.sections.safetyBaseline.title, "section-title"),
          fixedBlock(safetyBaselineText(document), "table"),
        ],
      },
    ],
  };
}

export function applyTiptapToPrdDocument(
  base: PrdDocumentV1,
  content: JSONContent,
): PrdDocumentV1;
export function applyTiptapToPrdDocument(
  base: PrdDocumentV2,
  content: JSONContent,
): PrdDocumentV2;
export function applyTiptapToPrdDocument(
  base: PrdDocument,
  content: JSONContent,
): PrdDocument;
export function applyTiptapToPrdDocument(
  base: PrdDocument,
  content: JSONContent,
): PrdDocument {
  const next = cloneDocument(base);
  walkJson(content, (node) => {
    const encodedPath = stringAttribute(node, "prdPath");
    const valueKind = stringAttribute(node, "prdValueKind");
    if (!encodedPath || (valueKind !== "string" && valueKind !== "inline")) return;
    const path = decodePath(encodedPath);
    if (!path || (next.protocol === "workbench.prd.v2" && !isV2EditablePath(path))) return;
    const value = valueKind === "string"
      ? stringFromContent(node.content)
      : inlinesFromContent(node.content);
    setPathValue(next, path, value);
  });

  if (next.protocol === "workbench.prd.v2") {
    normalizeV2Title(next);
    rebuildSectionBlocks(v2SectionProjections(next), content);
    next.sections.degradation.applicable = inlinePlainText(next.sections.degradation.content).trim() !== "不涉及";
    return next;
  }

  rebuildSectionBlocks(v1SectionProjections(next), content);
  return next;
}

function rebuildSectionBlocks(
  projections: readonly PrdSectionProjection[],
  content: JSONContent,
) {
  const updatedBlocks = new Map(
    projections.flatMap(({ section }) => section.blocks).map((block) => [block.id, block]),
  );
  const sectionNodes = new Map(
    (content.content ?? []).flatMap((node) => {
      const sectionKey = stringAttribute(node, "sectionKey");
      return node.type === "prdSection" && sectionKey
        ? [[sectionKey, node] as const]
        : [];
    }),
  );
  for (const projection of projections) {
    const sectionNode = sectionNodes.get(projection.key);
    if (!sectionNode) continue;
    projection.section.blocks = (sectionNode.content ?? []).flatMap((node, index) => {
      if (node.type === "prdFixedBlock" || stringAttribute(node, "prdRole") === "section-title") return [];
      const block = blockFromTiptapNode(node, projection.key, index, updatedBlocks);
      return block ? [block] : [];
    });
  }
}

function v1SectionProjections(document: PrdDocumentV1): PrdSectionProjection[] {
  return prdSectionKeys.map((key) => ({
    key,
    path: ["sections", key],
    section: document.sections[key],
  }));
}

function v2SectionProjections(document: PrdDocumentV2): PrdSectionProjection[] {
  return [
    {
      key: "v2:introduction.background",
      path: ["sections", "introduction", "background"],
      section: document.sections.introduction.background,
    },
    {
      key: "v2:introduction.scope",
      path: ["sections", "introduction", "scope"],
      section: document.sections.introduction.scope,
    },
    {
      key: "v2:introduction.usageScenarios",
      path: ["sections", "introduction", "usageScenarios"],
      section: document.sections.introduction.usageScenarios,
    },
    {
      key: "v2:businessRequirements.pageLinks",
      path: ["sections", "businessRequirements", "pageLinks"],
      section: document.sections.businessRequirements.pageLinks,
    },
    {
      key: "v2:businessRequirements.coreRules",
      path: ["sections", "businessRequirements", "coreRules"],
      section: document.sections.businessRequirements.coreRules,
    },
    {
      key: "v2:businessRequirements.flowAndPages",
      path: ["sections", "businessRequirements", "flowAndPages"],
      section: document.sections.businessRequirements.flowAndPages,
    },
    {
      key: "v2:businessRequirements.acceptanceCriteria",
      path: ["sections", "businessRequirements", "acceptanceCriteria"],
      section: document.sections.businessRequirements.acceptanceCriteria,
    },
  ];
}

function sectionToTiptap(
  projection: PrdSectionProjection,
  heading: JSONContent,
  trailing: JSONContent[] = [],
): JSONContent {
  return {
    type: "prdSection",
    attrs: { sectionKey: projection.key, dataId: `section-${projection.key.replace(/[^A-Za-z0-9]+/gu, "-")}` },
    content: [
      heading,
      ...projection.section.blocks.flatMap((block, blockIndex) => blockToTiptap(
        projection.path,
        block,
        blockIndex,
      )),
      ...trailing,
    ],
  };
}

function blockToTiptap(
  sectionPath: readonly PathPart[],
  block: PrdBlock,
  blockIndex: number,
): JSONContent[] {
  const path: PathPart[] = [...sectionPath, "blocks", blockIndex];
  switch (block.type) {
    case "paragraph":
      return [inlineField([...path, "content"], block.content, "body", "paragraph", undefined, block.id)];
    case "heading":
      return [inlineField([...path, "content"], block.content, "block-title", "heading", block.level, block.id)];
    case "bulletList":
    case "orderedList":
      return [{
        type: block.type,
        attrs: { dataId: block.id },
        content: block.items.map((item, itemIndex) => ({
          type: "listItem",
          content: [inlineField([...path, "items", itemIndex, "content"], item.content, "body", "paragraph", undefined, item.id)],
        })),
      }];
    case "table":
      return [tableToTiptap(block, path)];
    case "goal":
      return [card(block.id, "goal", [
        stringField([...path, "title"], block.title, "block-title", "heading", 3),
        inlineField([...path, "description"], block.description, "body"),
        stringField([...path, "successMetric"], block.successMetric, "metadata", "paragraph", undefined, "Metric: "),
      ])];
    case "persona":
      return [card(block.id, "persona", [
        stringField([...path, "name"], block.name, "block-title", "heading", 3),
        inlineField([...path, "description"], block.description, "body"),
        staticField("Needs"),
        stringList(block.needs, [...path, "needs"], "bulletList", `${block.id}-needs`),
        staticField("Pain points"),
        stringList(block.painPoints, [...path, "painPoints"], "bulletList", `${block.id}-pain-points`),
      ])];
    case "requirement":
      return [card(block.id, "requirement", [
        stringField([...path, "title"], block.title, "block-title", "heading", 3),
        inlineField([...path, "description"], block.description, "body"),
        staticField(`Priority: ${block.priority}`),
      ])];
    case "acceptanceCriterion":
      return [card(block.id, "acceptance", [
        inlineField([...path, "given"], block.given, "body", "paragraph", undefined, undefined, "Given "),
        inlineField([...path, "when"], block.when, "body", "paragraph", undefined, undefined, "When "),
        inlineField([...path, "then"], block.then, "body", "paragraph", undefined, undefined, "Then "),
      ])];
    case "flow":
      return [card(block.id, "flow", [
        stringField([...path, "title"], block.title, "block-title", "heading", 3),
        stringField([...path, "actor"], block.actor, "metadata", "paragraph", undefined, "Actor: "),
        stringField([...path, "trigger"], block.trigger, "metadata", "paragraph", undefined, "Trigger: "),
        stringList(block.steps.map((step) => step.text), [...path, "steps"], "orderedList", `${block.id}-steps`, "text"),
        stringField([...path, "outcome"], block.outcome, "metadata", "paragraph", undefined, "Outcome: "),
      ])];
    case "risk":
      return [card(block.id, "risk", [
        inlineField([...path, "description"], block.description, "body"),
        staticField(`Likelihood: ${block.likelihood} · Impact: ${block.impact}`),
        inlineField([...path, "mitigation"], block.mitigation, "metadata", "paragraph", undefined, undefined, "Mitigation: "),
      ])];
    case "callout":
      return [card(block.id, "callout", [
        ...(block.title
          ? [stringField([...path, "title"], block.title, "block-title", "heading", 3)]
          : []),
        inlineField([...path, "content"], block.content, "body"),
      ])];
  }
}

function card(id: string, kind: string, content: JSONContent[]): JSONContent {
  return { type: "prdCard", attrs: { kind, dataId: id }, content };
}

function tableToTiptap(
  block: Extract<PrdBlock, { type: "table" }>,
  path: readonly PathPart[],
): JSONContent {
  return {
    type: "table",
    attrs: { dataId: block.id },
    content: [
      {
        type: "tableRow",
        content: block.columns.map((column, columnIndex) => ({
          type: "tableHeader",
          content: [stringField([...path, "columns", columnIndex, "label"], column.label, "metadata")],
        })),
      },
      ...block.rows.map((row, rowIndex) => ({
        type: "tableRow",
        content: row.cells.map((cell, cellIndex) => ({
          type: "tableCell",
          content: [inlineField([...path, "rows", rowIndex, "cells", cellIndex, "content"], cell.content, "body")],
        })),
      })),
    ],
  };
}

function stringList(
  values: readonly string[],
  path: readonly PathPart[],
  type: "bulletList" | "orderedList",
  id: string,
  childKey?: string,
): JSONContent {
  return {
    type,
    attrs: { dataId: id },
    content: values.map((value, index) => ({
      type: "listItem",
      content: [stringField(
        childKey ? [...path, index, childKey] : [...path, index],
        value,
        "body",
      )],
    })),
  };
}

function stringField(
  path: readonly PathPart[],
  value: string,
  role: FieldRole,
  type: "heading" | "paragraph" = "paragraph",
  level?: number,
  label?: string,
  dataId?: string,
): JSONContent {
  return {
    type,
    attrs: {
      ...(type === "heading" ? { level } : {}),
      ...(dataId ? { dataId } : {}),
      prdPath: encodePath(path),
      prdValueKind: "string",
      prdRole: role,
    },
    content: [
      ...(label ? [labelNode(label)] : []),
      ...(value ? [{ type: "text", text: value }] : []),
    ],
  };
}

function inlineField(
  path: readonly PathPart[],
  value: readonly PrdInline[],
  role: FieldRole,
  type: "heading" | "paragraph" = "paragraph",
  level?: number,
  dataId?: string,
  label?: string,
): JSONContent {
  return {
    type,
    attrs: {
      ...(type === "heading" ? { level } : {}),
      ...(dataId ? { dataId } : {}),
      prdPath: encodePath(path),
      prdValueKind: "inline",
      prdRole: role,
    },
    content: [
      ...(label ? [labelNode(label)] : []),
      ...value.map(inlineToTiptap),
    ],
  };
}

function staticField(text: string): JSONContent {
  return {
    type: "paragraph",
    attrs: { prdRole: "metadata" },
    content: [labelNode(text)],
  };
}

function fixedBlock(
  text: string,
  variant: "diagram" | "section-title" | "subsection-title" | "table",
): JSONContent {
  return { type: "prdFixedBlock", attrs: { text, variant } };
}

function versionHistoryText(document: PrdDocumentV2): string {
  return [
    "版 本 历 史",
    "版本/状态 | 作者 | 参与者 | 起止日期 | 备注",
    ...document.versionHistory.map((entry) => [
      entry.status,
      entry.author,
      entry.participants.join("、"),
      `${entry.startDate} 至 ${entry.endDate}`,
      entry.notes,
    ].join(" | ")),
  ].join("\n");
}

function channelTableText(document: PrdDocumentV2): string {
  const table = document.sections.introduction.usageScenarios.channelTable;
  return [
    table.title,
    "序号 | 活动投放的可选渠道 | 是否投放",
    ...table.rows.map((row) => (
      `${row.sequence} | ${prdChannelLabels[row.channel]} | ${row.enabled ? "☑是 □否" : "□是 ☑否"}`
    )),
  ].join("\n");
}

type PrdV2Diagram = PrdDocumentV2["sections"]["businessRequirements"]["flowAndPages"]["diagrams"][number];

function diagramText(diagram: PrdV2Diagram): string {
  const labels = new Map(diagram.nodes.map((node) => [node.id, node.label]));
  return [
    diagram.title,
    diagram.description,
    `节点：${diagram.nodes.map((node) => node.label).join(" -> ")}`,
    "节点关系：",
    ...diagram.edges.map((edge) => (
      `${labels.get(edge.from) ?? edge.from} -> ${labels.get(edge.to) ?? edge.to}${edge.label ? `（${edge.label}）` : ""}`
    )),
  ].join("\n");
}

function safetyBaselineText(document: PrdDocumentV2): string {
  return [
    document.sections.safetyBaseline.intro,
    "",
    "序号 | 需求安全基线内容 | 范围 | 是否涉及 | 备注",
    ...document.sections.safetyBaseline.rows.map((row, index) => {
      const baseline = prdSafetyBaselineItems[index];
      return baseline
        ? `${row.sequence} | ${baseline.requirement} | ${baseline.scope} | ${row.applicability} | ${row.remarks ?? "-"}`
        : "";
    }),
  ].join("\n");
}

function labelNode(text: string): JSONContent {
  return { type: "prdLabel", attrs: { text } };
}

function inlineToTiptap(inline: PrdInline): JSONContent {
  if (inline.type === "citation") {
    return {
      type: "prdCitation",
      attrs: { citationId: inline.citationId, label: inline.label },
    };
  }
  if (inline.type === "reference") {
    return {
      type: "prdReference",
      attrs: {
        targetType: inline.targetType,
        targetId: inline.targetId,
        label: inline.label,
      },
    };
  }
  if (inline.type === "link") {
    return {
      type: "text",
      text: inline.text,
      marks: [{ type: "link", attrs: { href: inline.href } }],
    };
  }
  const markNames: Record<PrdTextMark, string> = {
    strong: "bold",
    emphasis: "italic",
    code: "code",
    strikethrough: "strike",
  };
  return {
    type: "text",
    text: inline.text,
    marks: inline.marks.map((mark) => ({ type: markNames[mark] })),
  };
}

function blockFromTiptapNode(
  node: JSONContent,
  sectionKey: string,
  index: number,
  updatedBlocks: ReadonlyMap<string, PrdBlock>,
): PrdBlock | null {
  const dataId = stringAttribute(node, "dataId");
  const existing = dataId ? updatedBlocks.get(dataId) : undefined;
  if (existing) return rebuildExistingBlock(existing, node);

  const id = editorIrId(dataId, `${sectionKey}-block-${index + 1}`);
  if (node.type === "paragraph") {
    return { id, type: "paragraph", content: inlinesFromContent(node.content) };
  }
  if (node.type === "heading") {
    return {
      id,
      type: "heading",
      level: headingLevel(node),
      content: inlinesFromContent(node.content),
    };
  }
  if (node.type === "bulletList" || node.type === "orderedList") {
    return {
      id,
      type: node.type,
      items: listItemsFromTiptap(node, []),
    };
  }
  if (node.type === "table") {
    return tableFromTiptap(node, { id, type: "table", columns: [], rows: [] });
  }
  return null;
}

function rebuildExistingBlock(block: PrdBlock, node: JSONContent): PrdBlock {
  switch (block.type) {
    case "paragraph":
      return { ...block, content: inlinesFromContent(node.content) };
    case "heading":
      return { ...block, level: headingLevel(node), content: inlinesFromContent(node.content) };
    case "bulletList":
    case "orderedList":
      return { ...block, items: listItemsFromTiptap(node, block.items) };
    case "table":
      return tableFromTiptap(node, block);
    case "persona":
      return {
        ...clearMissingCardFields(block, node),
        needs: stringListFromCard(node, `${block.id}-needs`),
        painPoints: stringListFromCard(node, `${block.id}-pain-points`),
      };
    case "flow":
      return {
        ...clearMissingCardFields(block, node),
        steps: flowStepsFromCard(node, block),
      };
    default:
      return clearMissingCardFields(block, node);
  }
}

function listItemsFromTiptap(
  node: JSONContent,
  existingItems: ReadonlyArray<{ id: string; content: PrdInline[] }>,
) {
  const byId = new Map(existingItems.map((item) => [item.id, item]));
  return (node.content ?? []).flatMap((item, index) => {
    if (item.type !== "listItem") return [];
    const field = firstTextBlock(item);
    if (!field) return [];
    const fieldId = stringAttribute(field, "dataId");
    const path = decodeNodePath(field);
    const originalIndex = indexAfter(path, "items");
    const original = (fieldId ? byId.get(fieldId) : undefined)
      ?? (originalIndex === null ? undefined : existingItems[originalIndex]);
    return [{
      id: original?.id ?? editorIrId(fieldId, `list-item-${index + 1}`),
      content: inlinesFromContent(field.content),
    }];
  });
}

function tableFromTiptap(
  node: JSONContent,
  existing: Extract<PrdBlock, { type: "table" }>,
): Extract<PrdBlock, { type: "table" }> {
  const tableId = existing.id;
  const tableRows = (node.content ?? []).filter((row) => row.type === "tableRow");
  const header = tableRows[0];
  const columns = (header?.content ?? []).flatMap((cell, index) => {
    if (cell.type !== "tableHeader" && cell.type !== "tableCell") return [];
    const field = firstTextBlock(cell);
    if (!field) return [];
    const originalIndex = indexAfter(decodeNodePath(field), "columns");
    const original = originalIndex === null ? undefined : existing.columns[originalIndex];
    return [{
      id: original?.id ?? editorIrId(stringAttribute(field, "dataId"), `${tableId}-column-${index + 1}`),
      label: stringFromContent(field.content),
    }];
  });
  const rows = tableRows.slice(1).map((row, rowIndex) => {
    const firstField = firstTextBlock(row);
    const originalIndex = indexAfter(decodeNodePath(firstField), "rows");
    const original = originalIndex === null ? undefined : existing.rows[originalIndex];
    return {
      id: original?.id ?? editorIrId(stringAttribute(row, "dataId"), `${tableId}-row-${rowIndex + 1}`),
      cells: columns.map((column, cellIndex) => {
        const field = firstTextBlock(row.content?.[cellIndex]);
        return {
          columnId: column.id,
          content: inlinesFromContent(field?.content),
        };
      }),
    };
  });
  return { ...existing, columns, rows };
}

function stringListFromCard(cardNode: JSONContent, listId: string): string[] {
  const list = (cardNode.content ?? []).find((node) => stringAttribute(node, "dataId") === listId);
  if (!list || (list.type !== "bulletList" && list.type !== "orderedList")) return [];
  return (list.content ?? []).flatMap((item) => {
    const field = firstTextBlock(item);
    return field ? [stringFromContent(field.content)] : [];
  });
}

function flowStepsFromCard(
  cardNode: JSONContent,
  block: Extract<PrdBlock, { type: "flow" }>,
) {
  const list = (cardNode.content ?? []).find((node) => (
    stringAttribute(node, "dataId") === `${block.id}-steps`
  ));
  if (!list || list.type !== "orderedList") return [];
  return (list.content ?? []).flatMap((item, index) => {
    const field = firstTextBlock(item);
    if (!field) return [];
    const originalIndex = indexAfter(decodeNodePath(field), "steps");
    const original = originalIndex === null ? undefined : block.steps[originalIndex];
    return [{
      id: original?.id ?? editorIrId(stringAttribute(field, "dataId"), `${block.id}-step-${index + 1}`),
      text: stringFromContent(field.content),
      requirementIds: original?.requirementIds ?? [],
    }];
  });
}

function clearMissingCardFields<TBlock extends PrdBlock>(block: TBlock, node: JSONContent): TBlock {
  const present = new Set<string>();
  walkJson(node, (child) => {
    const path = decodeNodePath(child);
    const field = path?.at(-1);
    if (typeof field === "string") present.add(field);
  });
  const next = cloneValue(block) as Record<string, unknown>;
  const clearString = (field: string) => {
    if (field in next && !present.has(field)) next[field] = "";
  };
  const clearInline = (field: string) => {
    if (field in next && !present.has(field)) next[field] = [];
  };
  switch (block.type) {
    case "goal":
      clearString("title");
      clearInline("description");
      clearString("successMetric");
      break;
    case "persona":
      clearString("name");
      clearInline("description");
      break;
    case "requirement":
      clearString("title");
      clearInline("description");
      break;
    case "acceptanceCriterion":
      clearInline("given");
      clearInline("when");
      clearInline("then");
      break;
    case "flow":
      clearString("title");
      clearString("actor");
      clearString("trigger");
      clearString("outcome");
      break;
    case "risk":
      clearInline("description");
      clearInline("mitigation");
      break;
    case "callout":
      if (!present.has("title")) next.title = null;
      clearInline("content");
      break;
  }
  return next as TBlock;
}

function firstTextBlock(node: JSONContent | undefined): JSONContent | null {
  if (!node) return null;
  if (node.type === "paragraph" || node.type === "heading") return node;
  for (const child of node.content ?? []) {
    const found = firstTextBlock(child);
    if (found) return found;
  }
  return null;
}

function headingLevel(node: JSONContent): 2 | 3 {
  return node.attrs?.level === 2 ? 2 : 3;
}

function decodeNodePath(node: JSONContent | null | undefined): PathPart[] | null {
  const encoded = node ? stringAttribute(node, "prdPath") : null;
  return encoded ? decodePath(encoded) : null;
}

function indexAfter(path: readonly PathPart[] | null, key: string): number | null {
  if (!path) return null;
  const index = path.lastIndexOf(key);
  const value = index < 0 ? undefined : path[index + 1];
  return typeof value === "number" ? value : null;
}

function editorIrId(value: string | null, fallback: string): string {
  if (value && /^[A-Za-z][A-Za-z0-9]*(?:[-_.:][A-Za-z0-9]+)*$/u.test(value) && value.length <= 96) {
    return value;
  }
  const seed = (value ?? fallback)
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return `editor-${seed || "block"}`;
}

function isV2EditablePath(path: readonly PathPart[]): boolean {
  if (pathEquals(path, ["title"])) return true;
  if (pathEquals(path, ["sections", "businessRequirements", "summary"])) return true;
  if (pathEquals(path, ["sections", "degradation", "content"])) return true;
  return [
    ["sections", "introduction", "background", "blocks"],
    ["sections", "introduction", "scope", "blocks"],
    ["sections", "introduction", "usageScenarios", "blocks"],
    ["sections", "businessRequirements", "pageLinks", "blocks"],
    ["sections", "businessRequirements", "coreRules", "blocks"],
    ["sections", "businessRequirements", "flowAndPages", "blocks"],
    ["sections", "businessRequirements", "acceptanceCriteria", "blocks"],
  ].some((prefix) => pathStartsWith(path, prefix));
}

function pathEquals(path: readonly PathPart[], expected: readonly PathPart[]): boolean {
  return path.length === expected.length && pathStartsWith(path, expected);
}

function pathStartsWith(path: readonly PathPart[], prefix: readonly PathPart[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

function normalizeV2Title(document: PrdDocumentV2) {
  const editedTitle = document.title.trim();
  const workOrderName = editedTitle.endsWith(prdV2TitleSuffix)
    ? editedTitle.slice(0, -prdV2TitleSuffix.length).trim()
    : editedTitle;
  const title = workOrderName ? `${workOrderName}${prdV2TitleSuffix}` : "";
  document.title = title;
  document.cover.workOrderName = workOrderName;
  document.cover.title = title;
}

function inlinePlainText(inlines: readonly PrdInline[]): string {
  return inlines.map((inline) => {
    if (inline.type === "citation" || inline.type === "reference") return inline.label ?? "";
    return inline.text;
  }).join("");
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function inlinesFromContent(content: JSONContent[] | undefined): PrdInline[] {
  const result: PrdInline[] = [];
  for (const node of content ?? []) {
    if (node.type === "prdLabel") continue;
    if (node.type === "prdCitation") {
      result.push({
        type: "citation",
        citationId: stringAttribute(node, "citationId") ?? "",
        label: nullableStringAttribute(node, "label"),
      });
      continue;
    }
    if (node.type === "prdReference") {
      result.push({
        type: "reference",
        targetType: (stringAttribute(node, "targetType") ?? "section") as Extract<PrdInline, { type: "reference" }>["targetType"],
        targetId: stringAttribute(node, "targetId") ?? "",
        label: nullableStringAttribute(node, "label"),
      });
      continue;
    }
    if (node.type === "hardBreak") {
      appendText(result, "\n", []);
      continue;
    }
    if (node.type !== "text" || typeof node.text !== "string" || node.text.length === 0) continue;
    const link = node.marks?.find((mark) => mark.type === "link");
    if (link) {
      result.push({
        type: "link",
        text: node.text,
        href: stringAttribute(link, "href") ?? "#",
      });
      continue;
    }
    const marks = (node.marks ?? []).flatMap((mark) => {
      if (mark.type === "bold") return ["strong" as const];
      if (mark.type === "italic") return ["emphasis" as const];
      if (mark.type === "code") return ["code" as const];
      if (mark.type === "strike") return ["strikethrough" as const];
      return [];
    });
    appendText(result, node.text, [...new Set(marks)]);
  }
  return result;
}

function appendText(
  result: PrdInline[],
  text: string,
  marks: Extract<PrdInline, { type: "text" }>["marks"],
) {
  const previous = result.at(-1);
  if (
    previous?.type === "text"
    && previous.marks.length === marks.length
    && previous.marks.every((mark, index) => mark === marks[index])
  ) {
    previous.text += text;
  } else {
    result.push({ type: "text", text, marks });
  }
}

function stringFromContent(content: JSONContent[] | undefined): string {
  return (content ?? []).map((node) => {
    if (node.type === "text") return node.text ?? "";
    if (node.type === "hardBreak") return "\n";
    return "";
  }).join("");
}

function walkJson(node: JSONContent, visit: (node: JSONContent) => void) {
  visit(node);
  for (const child of node.content ?? []) walkJson(child, visit);
}

function encodePath(path: readonly PathPart[]): string {
  return JSON.stringify(path);
}

function decodePath(value: string): PathPart[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed.every((part) => typeof part === "string" || Number.isInteger(part))
      ? parsed as PathPart[]
      : null;
  } catch {
    return null;
  }
}

function stringAttribute(node: { attrs?: Record<string, unknown> }, key: string): string | null {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value : null;
}

function nullableStringAttribute(
  node: { attrs?: Record<string, unknown> },
  key: string,
): string | null {
  const value = node.attrs?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cloneDocument(document: PrdDocument): PrdDocument {
  return JSON.parse(JSON.stringify(document)) as PrdDocument;
}

function setPathValue(document: PrdDocument, path: readonly PathPart[], value: unknown) {
  let cursor: Record<string, unknown> | unknown[] = document as unknown as Record<string, unknown>;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    const child = (cursor as Record<string, unknown>)[String(key)] as Record<string, unknown> | unknown[];
    if (!child || typeof child !== "object") return;
    cursor = child;
  }
  (cursor as Record<string, unknown>)[String(path.at(-1))] = value;
}
