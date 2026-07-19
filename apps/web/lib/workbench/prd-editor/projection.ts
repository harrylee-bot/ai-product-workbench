import type { JSONContent } from "@tiptap/core";
import {
  prdSectionKeys,
  type PrdBlock,
  type PrdDocument,
  type PrdInline,
  type PrdSectionKey,
} from "@workbench/workbench-contracts";

type PathPart = string | number;
type FieldRole = "body" | "block-title" | "metadata" | "section-title" | "title";
type PrdTextMark = Extract<PrdInline, { type: "text" }>["marks"][number];

export function prdDocumentToTiptap(document: PrdDocument): JSONContent {
  return {
    type: "doc",
    content: [
      stringField(["title"], document.title, "title", "heading", 1, undefined, document.documentId),
      ...prdSectionKeys.map((key, index) => sectionToTiptap(document, key, index)),
    ],
  };
}

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
    if (!path) return;
    const value = valueKind === "string"
      ? stringFromContent(node.content)
      : inlinesFromContent(node.content);
    setPathValue(next, path, value);
  });
  const updatedBlocks = new Map(
    prdSectionKeys.flatMap((key) => next.sections[key].blocks).map((block) => [block.id, block]),
  );
  const sectionNodes = new Map(
    (content.content ?? []).flatMap((node) => {
      const sectionKey = stringAttribute(node, "sectionKey");
      return node.type === "prdSection" && isPrdSectionKey(sectionKey)
        ? [[sectionKey, node] as const]
        : [];
    }),
  );
  for (const key of prdSectionKeys) {
    const sectionNode = sectionNodes.get(key);
    if (!sectionNode) continue;
    next.sections[key].blocks = (sectionNode.content ?? []).flatMap((node, index) => {
      if (stringAttribute(node, "prdRole") === "section-title") return [];
      const block = blockFromTiptapNode(node, key, index, updatedBlocks);
      return block ? [block] : [];
    });
  }
  return next;
}

function sectionToTiptap(
  document: PrdDocument,
  key: PrdSectionKey,
  index: number,
): JSONContent {
  const section = document.sections[key];
  return {
    type: "prdSection",
    attrs: { sectionKey: key, dataId: `section-${key}` },
    content: [
      stringField(
        ["sections", key, "title"],
        section.title,
        "section-title",
        "heading",
        2,
        `${index + 1}. `,
      ),
      ...section.blocks.flatMap((block, blockIndex) => blockToTiptap(key, block, blockIndex)),
    ],
  };
}

function blockToTiptap(
  sectionKey: PrdSectionKey,
  block: PrdBlock,
  blockIndex: number,
): JSONContent[] {
  const path: PathPart[] = ["sections", sectionKey, "blocks", blockIndex];
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
  sectionKey: PrdSectionKey,
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

function isPrdSectionKey(value: string | null): value is PrdSectionKey {
  return value !== null && (prdSectionKeys as readonly string[]).includes(value);
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
