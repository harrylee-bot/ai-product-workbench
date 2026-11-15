"use client";

import { WorkbenchQueryProvider } from "@/lib/workbench/query";
import { WorkbenchTransportProvider } from "@/lib/workbench/transport";
import { useWorkbenchPublicPrototypeShare } from "@/lib/workbench/features";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPrototypeSandboxDocument, parsePrototypePreviewPage } from "@/components/workbench/prototype-v2-preview";

export function PrototypeShareClient({ token }: { token: string }) {
  return (
    <WorkbenchQueryProvider>
      <WorkbenchTransportProvider>
        <PrototypeShareContent token={token} />
      </WorkbenchTransportProvider>
    </WorkbenchQueryProvider>
  );
}

function PrototypeShareContent({ token }: { token: string }) {
  const query = useWorkbenchPublicPrototypeShare(token);
  if (query.isPending) return <Status>正在加载交互原型...</Status>;
  if (query.isError || !query.data) return <Status error>分享链接无效或已失效</Status>;
  return <PrototypeShareView value={query.data.value} />;
}

function PrototypeShareView({ value }: { value: import("@workbench/workbench-contracts").PrototypePublicShare }) {
  const pages = useMemo(() => [...value.revision.pages].sort((a, b) => a.order - b.order), [value.revision.pages]);
  const [selectedId, setSelectedId] = useState(pages[0]?.id ?? "");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [urlRestored, setUrlRestored] = useState(false);
  const selected = pages.find((page) => page.id === selectedId) ?? pages[0];
  const selectedIdValue = selected?.id ?? "";
  const content = value.revision.previewHtml;
  const srcDoc = useMemo(() => createPrototypeSandboxDocument(content ?? ""), [content]);
  const selectIframePage = () => iframeRef.current?.contentWindow?.postMessage({ type: "workbench.prototype.select-page", pageId: selectedIdValue }, "*");
  useEffect(() => {
    const page = new URLSearchParams(window.location.search).get("prototypePage");
    if (page && pages.some((item) => item.id === page)) setSelectedId(page);
    setUrlRestored(true);
  }, [pages]);
  useEffect(() => {
    if (!urlRestored || !selectedIdValue) return;
    const url = new URL(window.location.href);
    url.searchParams.set("prototypePage", selectedIdValue);
    window.history.replaceState(window.history.state, "", url);
  }, [selectedIdValue, urlRestored]);
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== "null" && event.origin !== "") return;
      const pageId = parsePrototypePreviewPage(event.data);
      if (pageId && pages.some((page) => page.id === pageId)) setSelectedId(pageId);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [pages]);
  useEffect(() => { selectIframePage(); }, [selectedIdValue]);
  if (!selected || !content) return <Status error>此原型没有可预览页面</Status>;
  return (
    <div className="flex min-h-screen flex-col bg-[#111214] text-[#e8eaed]">
      <header className="flex min-h-[64px] items-center justify-between border-b border-white/[0.08] bg-[#18191b] px-5">
        <div>
          <h1 className="text-sm font-semibold">{value.revision.title}</h1>
          <p className="mt-1 text-xs text-[#9aa0a6]">只读交互原型 · {pages.length} 个页面</p>
        </div>
      </header>
      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav className="border-b border-white/[0.08] bg-[#18191b]/70 p-3 lg:border-b-0 lg:border-r">
          {pages.map((page) => (
            <button key={page.id} type="button" onClick={() => setSelectedId(page.id)} aria-pressed={page.id === selected.id} className={`mb-1 block w-full rounded-lg px-3 py-2 text-left text-sm ${page.id === selected.id ? "bg-[#3a2d4b]" : "hover:bg-white/[0.06]"}`}>
              {page.title}
            </button>
          ))}
        </nav>
        <section className="min-h-[calc(100dvh-64px)] bg-[#202124] p-3 sm:p-5">
          <iframe key={value.revision.id} ref={iframeRef} title={value.revision.title} srcDoc={srcDoc} onLoad={selectIframePage} sandbox="allow-scripts allow-forms" className="h-[calc(100dvh-104px)] min-h-[420px] w-full rounded-lg border border-white/[0.1] bg-white" />
        </section>
      </main>
    </div>
  );
}

function Status({ children, error = false }: { children: string; error?: boolean }) {
  return <div className={`grid min-h-screen place-items-center bg-[#111214] px-6 text-sm ${error ? "text-[#f2a7a7]" : "text-[#aeb3bb]"}`}>{children}</div>;
}
