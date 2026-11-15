"use client";
import { useState } from "react";
import { WorkbenchQueryProvider } from "@/lib/workbench/query";
import { WorkbenchTransportProvider } from "@/lib/workbench/transport";
import { useWorkbenchPublicPrototypeShare } from "@/lib/workbench/features/prototype-shares";
import { PageStage } from "./page-stage";
export function PublicPrototype({ token }: { token: string }) {
  return (
    <WorkbenchQueryProvider>
      <WorkbenchTransportProvider>
        <Content token={token} />
      </WorkbenchTransportProvider>
    </WorkbenchQueryProvider>
  );
}
function Content({ token }: { token: string }) {
  const query = useWorkbenchPublicPrototypeShare(token);
  const [page, setPage] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("page") ?? ""),
  );
  if (query.isPending)
    return (
      <div className="studio-loading" role="status">
        正在加载共享原型…
      </div>
    );
  if (!query.data)
    return (
      <div className="studio-loading">
        <h1>分享不可用</h1>
        <p>此链接已失效、被撤销，或无访问权限。</p>
        <button onClick={() => void query.refetch()}>重试</button>
      </div>
    );
  const revision = query.data.value.revision,
    pages = [...revision.pages].sort((a, b) => a.order - b.order),
    pageId = pages.some((p) => p.id === page) ? page : (pages[0]?.id ?? "");
  return (
    <div className="visual-workspace studio-workspace studio-public">
      <header className="studio-topbar">
        <strong>{revision.title}</strong>
        <span>共享原型 · {pages.length} 页</span>
      </header>
      <PageStage
        readOnly
        revisionId={revision.id}
        title={revision.title}
        html={revision.previewHtml}
        pages={pages}
        pageId={pageId}
        onPage={(id) => {
          setPage(id);
          const url = new URL(window.location.href);
          url.searchParams.set("page", id);
          window.history.replaceState(window.history.state, "", url);
        }}
        onSelection={() => {}}
        draftIdentity="public"
        previews={[]}
        showDraft={false}
        running={false}
      />
    </div>
  );
}
