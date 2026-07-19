import type { Parent, Root, Text } from "mdast";
import { visit } from "unist-util-visit";

export interface WikiLinkNode extends Parent {
  readonly type: "wikiLink";
  readonly raw: string;
  readonly target: string;
  readonly alias?: string;
  children: [Text];
}

/**
 * GFM treats every pipe in a table row as a cell separator. Protect only the
 * alias separator in Obsidian links before parsing; the AST plugin restores it.
 */
export function protectWikilinkPipes(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: { marker: "`" | "~"; size: number } | undefined;

  return lines.map((line) => {
    const fenceMatch = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as "`" | "~";
      const size = fenceMatch[1]!.length;
      if (!fence) fence = { marker, size };
      else if (fence.marker === marker && size >= fence.size) fence = undefined;
      return line;
    }
    return fence ? line : protectInline(line);
  }).join("\n");
}

export function remarkWikilinks() {
  return (tree: Root): void => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (index === undefined || !parent || parent.type === "link" || parent.type === "linkReference") return;
      const replacements = splitTextNode(node);
      if (replacements.length === 1 && replacements[0] === node) return;
      const children = parent.children as unknown as Array<Text | WikiLinkNode>;
      children.splice(index, 1, ...replacements);
      return index + replacements.length;
    });
  };
}

export function isWikiLinkNode(value: unknown): value is WikiLinkNode {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "wikiLink";
}

function protectInline(line: string): string {
  let result = "";
  let cursor = 0;
  let codeRun = 0;

  while (cursor < line.length) {
    if (line[cursor] === "`") {
      const run = countRun(line, cursor, "`");
      codeRun = codeRun === 0 ? run : run === codeRun ? 0 : codeRun;
      result += line.slice(cursor, cursor + run);
      cursor += run;
      continue;
    }

    if (codeRun === 0 && line.startsWith("[[", cursor)) {
      const end = line.indexOf("]]", cursor + 2);
      if (end !== -1) {
        const raw = line.slice(cursor, end + 2);
        result += raw.replaceAll("|", "\\|");
        cursor = end + 2;
        continue;
      }
    }

    result += line[cursor];
    cursor += 1;
  }

  return result;
}

function splitTextNode(node: Text): Array<Text | WikiLinkNode> {
  const result: Array<Text | WikiLinkNode> = [];
  let cursor = 0;

  while (cursor < node.value.length) {
    const start = node.value.indexOf("[[", cursor);
    if (start === -1) break;
    const end = node.value.indexOf("]]", start + 2);
    if (end === -1) break;

    if (start > cursor) result.push({ type: "text", value: node.value.slice(cursor, start) });
    const value = node.value.slice(start + 2, end);
    const separator = value.indexOf("|");
    const target = (separator === -1 ? value : value.slice(0, separator)).trim();
    const alias = separator === -1 ? undefined : value.slice(separator + 1).trim();
    const label = alias || target;
    result.push({
      type: "wikiLink",
      raw: node.value.slice(start, end + 2),
      target,
      ...(alias ? { alias } : {}),
      children: [{ type: "text", value: label }],
    });
    cursor = end + 2;
  }

  if (result.length === 0) return [node];
  if (cursor < node.value.length) result.push({ type: "text", value: node.value.slice(cursor) });
  return result;
}

function countRun(value: string, start: number, character: string): number {
  let cursor = start;
  while (value[cursor] === character) cursor += 1;
  return cursor - start;
}
