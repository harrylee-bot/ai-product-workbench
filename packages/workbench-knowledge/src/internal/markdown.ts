import type { Content, Heading, Root, RootContent, YAML } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown, type Options as ToMarkdownOptions } from "mdast-util-to-markdown";
import { toString } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { KnowledgeBlock, KnowledgeBlockKind } from "../types.js";
import { isWikiLinkNode, protectWikilinkPipes, remarkWikilinks, type WikiLinkNode } from "./wikilink.js";

export interface MarkdownAnalysis {
  readonly tree: Root;
  readonly yaml?: string;
  readonly titleFromHeading?: string;
  readonly headings: readonly string[];
  readonly blocks: readonly KnowledgeBlock[];
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkWikilinks);

const serializeOptions = {
  extensions: [gfmToMarkdown()],
  handlers: {
    wikiLink(node: unknown) {
      return (node as unknown as WikiLinkNode).raw;
    },
  },
} as unknown as ToMarkdownOptions;

export function analyzeMarkdown(markdown: string): MarkdownAnalysis {
  const protectedMarkdown = protectWikilinkPipes(markdown);
  const parsed = markdownProcessor.parse(protectedMarkdown);
  const tree = markdownProcessor.runSync(parsed) as Root;
  const yaml = tree.children.find((node): node is YAML => node.type === "yaml")?.value;
  const headings: string[] = [];
  const headingStack: Array<{ depth: number; title: string }> = [];
  const blocks: KnowledgeBlock[] = [];

  for (const node of tree.children) {
    if (node.type === "yaml") continue;
    if (node.type === "heading") {
      const heading = normalizedText(node);
      headings.push(heading);
      while (headingStack.at(-1) && headingStack.at(-1)!.depth >= node.depth) headingStack.pop();
      headingStack.push({ depth: node.depth, title: heading });
    }

    const markdownText = serializeNode(node);
    blocks.push({
      sequence: blocks.length,
      kind: blockKind(node),
      headingPath: headingStack.map((entry) => entry.title),
      markdown: markdownText,
      retrievalText: projectNode(node),
      atomic: true,
    });
  }

  const titleFromHeading = tree.children.find((node): node is Heading => node.type === "heading" && node.depth === 1);
  return {
    tree,
    ...(yaml !== undefined ? { yaml } : {}),
    ...(titleFromHeading ? { titleFromHeading: normalizedText(titleFromHeading) } : {}),
    headings,
    blocks,
  };
}

export function serializeNode(node: RootContent | WikiLinkNode): string {
  const root: Root = { type: "root", children: [node as RootContent] };
  return toMarkdown(root, serializeOptions).trimEnd();
}

export function normalizedText(node: Content | WikiLinkNode): string {
  return toString(node as Content, { includeImageAlt: true })
    .replace(/\s+/g, " ")
    .trim();
}

function projectNode(node: RootContent): string {
  if (node.type === "thematicBreak") return "";
  if (node.type === "code") {
    const language = node.lang?.trim();
    return [language ? `Code (${language})` : "Code", node.value.trim()].filter(Boolean).join("\n");
  }
  if (node.type === "table") {
    return node.children.map((row) => row.children.map((cell) => normalizedText(cell)).join(" | ")).join("\n");
  }
  if (node.type === "list") {
    return node.children.map((item, index) => {
      const marker = node.ordered ? `${(node.start ?? 1) + index}.` : "-";
      return `${marker} ${normalizedText(item)}`;
    }).join("\n");
  }
  if (node.type === "html") return node.value.trim();
  return normalizedText(node);
}

function blockKind(node: RootContent): KnowledgeBlockKind {
  switch (node.type) {
    case "heading":
    case "paragraph":
    case "list":
    case "table":
    case "code":
    case "blockquote":
    case "html":
    case "definition":
      return node.type;
    case "thematicBreak":
      return "thematic_break";
    default:
      return "other";
  }
}

export function walkMarkdownTree(tree: Root, visitor: (node: Content | WikiLinkNode) => void): void {
  const visitNode = (node: Content | WikiLinkNode): void => {
    visitor(node);
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) visitNode(child as Content | WikiLinkNode);
    }
  };
  for (const node of tree.children) visitNode(node as Content | WikiLinkNode);
}

export function isYamlNode(node: RootContent): node is YAML {
  return node.type === "yaml";
}
