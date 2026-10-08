"use client";

import { businessDocumentSchema } from "@workbench/workbench-contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function safeDocumentLink(value: string): string {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function WorkbenchBusinessDocument({ content }: { content: unknown }) {
  const parsed = businessDocumentSchema.safeParse(typeof content === "string" ? { text: content } : content);
  if (!parsed.success) return <p className="p-[24px]" role="status">文档内容暂不可用</p>;
  const document = parsed.data;
  return <article className="prose prose-invert nowheel h-full w-full max-w-none overflow-auto break-words p-[24px] text-[#e8eaed] [overflow-wrap:anywhere]">
    {document.title && <h1>{document.title}</h1>}
    {document.markdown ? <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={safeDocumentLink}
      components={{
        a: ({ href, children }) => href ? <a href={href} rel="noopener noreferrer" target="_blank">{children}</a> : <span>{children}</span>,
        img: ({ src, alt }) => typeof src === "string" && src
          ? <a href={src} rel="noopener noreferrer" target="_blank">{alt || "图片"}</a>
          : <span>{alt || "图片"}</span>,
        table: ({ children }) => <div className="overflow-x-auto"><table>{children}</table></div>,
      }}
    >{document.markdown}</ReactMarkdown> : <div className="whitespace-pre-wrap">{document.text}</div>}
  </article>;
}
