"use client";
import { useState } from "react";
import { WorkbenchQueryProvider } from "@/lib/workbench/query";
import { WorkbenchTransportProvider } from "@/lib/workbench/transport";
import { useWorkbenchPublicPrototypeShare } from "@/lib/workbench/features/prototype-shares";
import { PageStage } from "./page-stage";
import { PublicShareStatus } from "./public-share-status";
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
  if (query.error || !query.data)
    return (
      <PublicShareStatus
        error={query.error}
        onRetry={() => void query.refetch()}
      />
    );
  const revision = query.data.value.revision,
    pages = [...revision.pages].sort((a, b) => a.order - b.order),
    pageId = pages.some((p) => p.id === page) ? page : (pages[0]?.id ?? "");
  if (!revision.previewHtml || pages.length === 0)
    return (
      <PublicShareStatus
        unavailablePreview
        onRetry={() => void query.refetch()}
      />
    );
  return (
    <div className="studio-shell visual-workspace studio-workspace studio-public">
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
