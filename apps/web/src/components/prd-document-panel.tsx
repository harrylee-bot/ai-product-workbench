"use client";

import { useAgent, UseAgentUpdate } from "@copilotkit/react-core/v2";
import {
  Check,
  ChevronsLeft,
  Copy,
  Download,
  MessageSquare,
  MoreHorizontal,
  Share2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { IconButton } from "@/components/ui";
import type { Phase1PrdPreview } from "@/components/workspace-preview/types";

type PrdState = {
  status?: "idle" | "writing" | "ready" | "failed";
  title?: string;
  markdown?: string;
  sections?: TocItem[];
  activeHeadingId?: string;
  prdDocumentId?: string;
  updatedAt?: string;
};

type TocItem = {
  id: string;
  title: string;
  level: number;
  order: number;
};

type ViewMode = "markdown" | "word";

export function PrdDocumentPanel({
  dbPreview,
  onRunSettled,
}: {
  dbPreview?: Phase1PrdPreview | null;
  onRunSettled?: () => void;
}) {
  const { agent } = useAgent({
    agentId: "workbench-prd",
    updates: [UseAgentUpdate.OnStateChanged, UseAgentUpdate.OnRunStatusChanged],
    throttleMs: 120,
  });
  const [mode, setMode] = useState<ViewMode>("markdown");
  const [tocCollapsed, setTocCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToEndRef = useRef(true);
  const wasRunningRef = useRef(false);

  const runtimeState = normalizeRuntimePrdState((agent.state as Record<string, unknown> | undefined)?.workbenchPrd);
  const documentState = runtimeState?.markdown
    ? runtimeState
    : dbPreviewToPrdState(dbPreview);
  const markdown = documentState.markdown ?? "";
  const headings = useMemo(() => {
    const fromMarkdown = headingsFromMarkdown(markdown);
    const fromState = documentState.sections ?? [];
    return fromMarkdown.length ? fromMarkdown : fromState;
  }, [documentState.sections, markdown]);
  const activeHeadingId = documentState.activeHeadingId ?? headings.at(-1)?.id;
  const writing = documentState.status === "writing" || agent.isRunning;
  const renderedBlocks = useMemo(() => parseMarkdown(markdown), [markdown]);

  useEffect(() => {
    if (wasRunningRef.current && !agent.isRunning) {
      onRunSettled?.();
    }
    wasRunningRef.current = agent.isRunning;
  }, [agent.isRunning, onRunSettled]);

  useEffect(() => {
    if (!shouldStickToEndRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: writing ? "smooth" : "auto" });
  }, [markdown, writing]);

  const handleScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    shouldStickToEndRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 140;
  };

  const handleCopy = async () => {
    if (!markdown) return;
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const handleDownload = () => {
    if (!markdown) return;
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(documentState.title || "PRD")}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  return (
    <aside className="relative flex min-h-0 min-w-0 flex-col bg-white">
      <div className="absolute left-1/2 top-7 z-20 -translate-x-1/2">
        {writing ? (
          <div className="rounded-[10px] border border-blue-500 bg-white px-4 py-2 text-sm font-semibold text-blue-600 shadow-[0_8px_24px_rgba(37,99,235,0.12)]">
            撰写中...
          </div>
        ) : null}
      </div>
      <div className="flex h-14 shrink-0 items-center justify-end gap-1 border-b border-gray-100 px-4 text-gray-300">
        <IconButton label={copied ? "已复制 Markdown" : "复制 Markdown"} variant="ghost" disabled={!markdown} onClick={() => void handleCopy()}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </IconButton>
        <IconButton label="下载 Markdown" variant="ghost" disabled={!markdown} onClick={handleDownload}>
          <Download className="h-4 w-4" />
        </IconButton>
        <IconButton label="分享（暂未开放）" variant="ghost" disabled>
          <Share2 className="h-4 w-4" />
        </IconButton>
        <IconButton label="评论（暂未开放）" variant="ghost" disabled>
          <MessageSquare className="h-4 w-4" />
        </IconButton>
        <IconButton label="更多（暂未开放）" variant="ghost" disabled>
          <MoreHorizontal className="h-4 w-4" />
        </IconButton>
        <div className="mx-1 h-5 w-px bg-gray-200" />
        <IconButton label="关闭预览（暂未开放）" variant="ghost" disabled>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="grid h-full min-h-0 grid-cols-[auto_minmax(0,1fr)]">
          <nav
            className={[
              "min-h-0 border-r border-gray-100 bg-white transition-[width] duration-200",
              tocCollapsed ? "w-10" : "w-56",
            ].join(" ")}
            aria-label="PRD 目录"
          >
            <button
              type="button"
              className="flex h-12 w-full items-center px-4 text-left text-gray-500 hover:text-gray-950"
              onClick={() => setTocCollapsed((value) => !value)}
              title={tocCollapsed ? "展开目录" : "收起目录"}
            >
              <ChevronsLeft className={["h-4 w-4 transition", tocCollapsed ? "rotate-180" : ""].join(" ")} />
            </button>
            {!tocCollapsed ? (
              <div className="workbench-scrollbar h-[calc(100%-48px)] overflow-y-auto px-4 pb-6 text-sm">
                {headings.length ? (
                  headings.map((item) => (
                    <a
                      key={item.id}
                      href={`#${item.id}`}
                      className={[
                        "block truncate rounded-md py-1.5 text-xs leading-5 transition hover:text-blue-600",
                        item.id === activeHeadingId ? "font-semibold text-blue-600" : "text-gray-400",
                      ].join(" ")}
                      style={{ paddingLeft: `${Math.max(0, item.level - 1) * 12}px` }}
                    >
                      {item.title}
                    </a>
                  ))
                ) : (
                  <div className="pt-4 text-xs leading-5 text-gray-400">等待 PRD 正文生成</div>
                )}
              </div>
            ) : null}
          </nav>
          <div ref={scrollRef} onScroll={handleScroll} className="workbench-scrollbar min-h-0 overflow-y-auto">
            <div className="mx-auto flex min-h-full w-full max-w-[860px] flex-col px-10 pb-28 pt-14">
              <div className="mb-6 flex justify-center">
                <div className="inline-flex rounded-[10px] border border-gray-200 bg-white p-1 text-xs font-semibold text-gray-500">
                  <button
                    type="button"
                    className={["rounded-md px-3 py-1.5 transition", mode === "markdown" ? "bg-gray-950 text-white" : "hover:text-gray-950"].join(" ")}
                    onClick={() => setMode("markdown")}
                  >
                    Markdown 预览
                  </button>
                  <button
                    type="button"
                    className={["rounded-md px-3 py-1.5 transition", mode === "word" ? "bg-gray-950 text-white" : "hover:text-gray-950"].join(" ")}
                    onClick={() => setMode("word")}
                  >
                    Word 预览
                  </button>
                </div>
              </div>
              {markdown ? (
                <article className={mode === "word" ? "prd-word-preview" : "prd-markdown-preview"}>
                  {renderedBlocks.map((block, index) => renderBlock(block, `${block.type}-${index}`))}
                </article>
              ) : (
                <div className="flex flex-1 items-center justify-center text-center text-sm leading-6 text-gray-400">
                  右侧会显示生成出来的正式 PRD 文档。
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

type MarkdownBlock =
  | { type: "heading"; id: string; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; text: string };

function normalizeRuntimePrdState(value: unknown): PrdState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    status: stringValue(record.status) as PrdState["status"],
    title: stringValue(record.title),
    markdown: stringValue(record.markdown) ?? "",
    sections: Array.isArray(record.sections)
      ? record.sections.map((item, index) => normalizeTocItem(item, index)).filter((item): item is TocItem => Boolean(item))
      : [],
    activeHeadingId: stringValue(record.activeHeadingId),
    prdDocumentId: stringValue(record.prdDocumentId),
    updatedAt: stringValue(record.updatedAt),
  };
}

function dbPreviewToPrdState(preview?: Phase1PrdPreview | null): PrdState {
  if (!preview) return { status: "idle", title: "产品需求文档（PRD）", markdown: "", sections: [] };
  const sections = [...preview.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const markdown = [
    `# ${preview.title || "产品需求文档（PRD）"}`,
    ...sections.flatMap((section) => ["", `## ${section.title}`, "", section.content || ""]),
  ].join("\n").trim();
  return {
    status: "ready",
    title: preview.title,
    markdown,
    sections: sections.map((section, index) => ({
      id: section.id || `section-${index + 1}`,
      title: section.title,
      level: 2,
      order: section.order ?? index,
    })),
    activeHeadingId: sections.at(-1)?.id,
    prdDocumentId: preview.id,
  };
}

function headingsFromMarkdown(markdown: string): TocItem[] {
  return markdown
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const match = line.match(/^(#{1,4})\s+(.+?)\s*$/);
      if (!match) return [];
      const marker = match[1] ?? "#";
      const title = (match[2] ?? "").trim();
      if (!title) return [];
      return [{
        id: headingId(title, index),
        title,
        level: marker.length,
        order: index,
      }];
    });
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const codeBlock: { value: string[] | null } = { value: null };

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n").trim() });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list?.items.length) blocks.push({ type: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) {
      if (codeBlock.value) {
        blocks.push({ type: "code", text: codeBlock.value.join("\n") });
        codeBlock.value = null;
      } else {
        flushParagraph();
        flushList();
        codeBlock.value = [];
      }
      return;
    }
    if (codeBlock.value) {
      codeBlock.value.push(line);
      return;
    }
    const heading = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      const marker = heading[1] ?? "#";
      const text = (heading[2] ?? "").trim();
      if (!text) return;
      blocks.push({ type: "heading", id: headingId(text, index), level: marker.length, text });
      return;
    }
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.、]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextOrdered = Boolean(ordered);
      if (!list || list.ordered !== nextOrdered) flushList();
      list = list ?? { ordered: nextOrdered, items: [] };
      list.items.push((unordered?.[1] ?? ordered?.[1] ?? "").trim());
      return;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      return;
    }
    paragraph.push(line);
  });

  flushParagraph();
  flushList();
  if (codeBlock.value) blocks.push({ type: "code", text: codeBlock.value.join("\n") });
  return blocks;
}

function renderBlock(block: MarkdownBlock, key: string) {
  if (block.type === "heading") {
    const Tag = block.level === 1 ? "h1" : block.level === 2 ? "h2" : block.level === 3 ? "h3" : "h4";
    return <Tag key={key} id={block.id}>{block.text}</Tag>;
  }
  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";
    return (
      <ListTag key={key}>
        {block.items.map((item, index) => <li key={`${key}-${index}`}>{item}</li>)}
      </ListTag>
    );
  }
  if (block.type === "code") {
    return <pre key={key}><code>{block.text}</code></pre>;
  }
  return <p key={key}>{block.text}</p>;
}

function normalizeTocItem(value: unknown, index: number): TocItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = stringValue(record.title);
  if (!title) return null;
  return {
    id: stringValue(record.id) ?? headingId(title, index),
    title,
    level: numberValue(record.level) ?? 2,
    order: numberValue(record.order) ?? index,
  };
}

function headingId(title: string, index: number) {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `heading-${index + 1}`;
}

function safeFileName(name: string) {
  return name.replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "PRD";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
