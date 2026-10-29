"use client";

import { JSONUIProvider, Renderer, type ComponentRenderProps, type RendererProps } from "@json-render/react";
import type { GenerationPreview, GenerationPreviewNode } from "@workbench/workbench-contracts";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Streamdown } from "streamdown";

function PreviewNode({ element, children }: ComponentRenderProps<{ node: GenerationPreviewNode }>) {
  const node = element.props.node;
  const container = node.kind === "frame" || node.kind === "form";
  const style: CSSProperties = {
    position: node.absolute ? "absolute" : "relative",
    left: node.absolute ? node.x : undefined, top: node.absolute ? node.y : undefined,
    width: node.width ?? undefined, minHeight: node.height ?? undefined,
    flexShrink: 0, display: container ? "flex" : "block", flexDirection: node.direction,
    gap: node.gap, padding: node.padding, borderRadius: node.radius,
    background: node.fill ?? undefined, color: node.color ?? "#202124",
    fontSize: node.fontSize ?? 14, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
  };
  if (node.kind === "input") return <input aria-label={node.text || "输入框"} disabled placeholder={node.text} style={style} className="border border-[#d7dbe1] px-3 py-2" />;
  if (node.kind === "button") return <button disabled style={style} className="border border-[#d7dbe1] px-3 py-2">{node.text}{children}</button>;
  if (node.kind === "image" || node.kind === "icon") return <div aria-label={node.text} role="img" style={style} className="border border-[#e8eaed] bg-[#f1f3f4]" />;
  return <div style={style}>{container ? null : node.text}{children}</div>;
}

const registry = {
  Node: PreviewNode,
  Screen: ({ children }: ComponentRenderProps) => <>{children}</>,
};

export function generationPreviewTree(nodes: GenerationPreviewNode[]): NonNullable<RendererProps["tree"]> {
  const root = "preview-screen";
  const elements: NonNullable<RendererProps["tree"]>["elements"] = Object.create(null);
  elements[root] = { key: root, type: "Screen", props: {}, children: [] };
  const unique = new Map(nodes.map((node) => [node.id, node]));
  // Build only reachable nodes. Cycles in unfinished source data cannot recurse.
  const pending = [...unique.values()];
  for (let pass = 0; pass <= nodes.length && pending.length; pass += 1) {
    let added = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const node = pending[index]!;
      const parent = node.parentId && unique.has(node.parentId) ? `n:${node.parentId}` : root;
      if (!elements[parent] || parent === `n:${node.id}`) continue;
      const key = `n:${node.id}`;
      elements[key] = { key, type: "Node", props: { node }, children: [] };
      elements[parent]!.children!.unshift(key);
      pending.splice(index, 1);
      added = true;
    }
    if (!added) break;
  }
  return { root, elements };
}

export function WorkbenchGenerationPreview({ previews }: { previews: GenerationPreview[] }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedScreenId, setSelectedScreenId] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  const preview = previews.find((item) => item.artifactIndex === selectedIndex) ?? previews.at(-1);
  const activeScreen = preview?.screens.find((item) => item.id === selectedScreenId) ?? preview?.screens[0];
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport || preview?.kind !== "prototype") return;
    const measure = () => {
      if (viewport.clientWidth > 40) setAvailableWidth(viewport.clientWidth - 40);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [preview?.kind]);
  useEffect(() => {
    const viewport = scrollRef.current;
    if (viewport && followRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [preview?.markdown]);
  if (!preview) return null;
  const scale = activeScreen && availableWidth ? Math.min(1, availableWidth / activeScreen.width) : 1;
  return (
    <section
      aria-label="生成中预览"
      className="pointer-events-auto absolute bottom-[180px] left-1/2 top-[82px] z-50 flex w-[min(760px,calc(100%_-_48px))] -translate-x-1/2 flex-col overflow-hidden rounded-[12px] border border-[#7467f6]/60 bg-[#18191b] shadow-[0_24px_90px_-30px_#000] max-sm:bottom-[150px] max-sm:top-[116px]"
      data-workbench-generation-preview={preview.kind}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
        <span className="size-2 rounded-full bg-[#a69cff] motion-safe:animate-pulse" />
        <span className="text-xs text-[#c8c3ff]" role="status">正在生成 · 实时预览</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#f1f3f4]">{preview.title}</span>
        {previews.length > 1 && previews.map((item) => <button aria-pressed={preview.artifactIndex === item.artifactIndex} className="rounded bg-white/10 px-2 py-1 text-xs text-white" key={item.artifactIndex} onClick={() => setSelectedIndex(item.artifactIndex)} type="button">{item.kind === "prd" ? "文档" : "原型"}</button>)}
      </header>
      {preview.kind === "prototype" && preview.screens.length > 1 && <nav aria-label="生成中的页面" className="flex shrink-0 gap-2 overflow-x-auto px-4 py-2">{preview.screens.map((screen) => <button aria-pressed={activeScreen?.id === screen.id} className="shrink-0 rounded bg-white/10 px-3 py-1 text-xs text-white" key={screen.id} onClick={() => setSelectedScreenId(screen.id)} type="button">{screen.name}</button>)}</nav>}
      <div className="min-h-0 flex-1 overflow-auto bg-[#f1f3f4] p-5 text-[#202124]" ref={scrollRef} onScroll={(event) => { const node = event.currentTarget; followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}>
        {preview.kind === "prd" ? <article className="prose prose-sm mx-auto max-w-none rounded bg-white p-7 shadow-sm [&_table]:text-xs"><h1 className="mb-5 text-xl font-semibold">{preview.title}</h1><Streamdown controls={false} isAnimating skipHtml components={{ a: ({ children }) => <span>{children}</span>, img: () => null }}>{preview.markdown}</Streamdown></article>
          : activeScreen ? <div className="relative mx-auto overflow-hidden bg-white shadow-sm" style={{ width: activeScreen.width * scale, minHeight: activeScreen.height * scale }}><div className="relative" style={{ width: activeScreen.width, minHeight: activeScreen.height, transform: `scale(${scale})`, transformOrigin: "top left" }}><JSONUIProvider registry={registry}><Renderer tree={generationPreviewTree(activeScreen.nodes)} registry={registry} loading /></JSONUIProvider></div></div>
            : <p className="text-sm text-[#5f6368]">正在构建页面结构…</p>}
      </div>
    </section>
  );
}
