"use client";

import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/api";

type ShareSection = {
  id?: string;
  title?: string;
  content?: string;
  blocks?: Array<{
    id?: string;
    type?: string;
    content?: string;
  }>;
};

type SharePayload = {
  title: string;
  scope: "prd" | "prototype" | "both";
  readOnly: boolean;
  allowDownload: boolean;
  allowEdit: boolean;
  prd: { title: string; sections: ShareSection[]; updatedAt: string } | null;
  prototype: { title: string; html: string; pageCount: number; updatedAt: string } | null;
};

type Tab = "prd" | "prototype";

export function ShareViewerClient({ token }: { token: string }) {
  const [data, setData] = useState<SharePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("prd");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiRequest<SharePayload>(`/public/share/${encodeURIComponent(token)}`, { skipAuth: true })
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setTab(payload.prd ? "prd" : "prototype");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "分享内容不可用");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const hasPrd = Boolean(data?.prd);
  const hasPrototype = Boolean(data?.prototype);

  const sections = useMemo(
    () => (data?.prd?.sections ?? []).filter((section) => section.title || section.content),
    [data],
  );

  if (loading) {
    return <CenteredNotice title="加载中…" subtitle="正在获取分享内容" />;
  }
  if (error || !data) {
    return (
      <CenteredNotice
        title="无法打开分享"
        subtitle={error ?? "该分享链接可能已失效、被吊销或已过期。"}
        tone="error"
      />
    );
  }

  return (
    <div
      className="flex min-h-screen flex-col bg-gray-50 text-gray-900"
      // 软约束（FR-4.4）：禁用右键/选择/拖拽，降低随手下载与复制；非绝对防护。
      onContextMenu={(event) => event.preventDefault()}
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{data.title}</div>
          <div className="text-xs text-gray-500">只读分享 · 无需登录 · 不可下载与编辑</div>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 p-0.5 text-xs">
          {hasPrd ? (
            <TabButton active={tab === "prd"} onClick={() => setTab("prd")}>
              需求文档
            </TabButton>
          ) : null}
          {hasPrototype ? (
            <TabButton active={tab === "prototype"} onClick={() => setTab("prototype")}>
              原型
            </TabButton>
          ) : null}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {tab === "prd" && data.prd ? (
          <div className="mx-auto h-full max-w-3xl select-none overflow-y-auto px-6 py-8">
            <h1 className="mb-1 text-xl font-bold">{data.prd.title}</h1>
            <div className="mb-6 text-xs text-gray-400">
              更新于 {new Date(data.prd.updatedAt).toLocaleString("zh-CN")}
            </div>
            <div className="space-y-6">
              {sections.map((section, index) => (
                <section key={section.id ?? index}>
                  {section.title ? (
                    <h2 className="mb-2 border-l-2 border-gray-900 pl-2 text-base font-semibold">
                      {section.title}
                    </h2>
                  ) : null}
                  <div className="space-y-3">
                    {sectionBlocks(section).map((block, blockIndex) => (
                      <div
                        key={block.id ?? `${section.id ?? index}-${blockIndex}`}
                        data-block-id={block.id}
                        data-block-type={block.type}
                        className="whitespace-pre-wrap text-sm leading-7 text-gray-700"
                      >
                        {block.content}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : null}

        {tab === "prototype" && data.prototype ? (
          <iframe
            title={data.prototype.title}
            srcDoc={data.prototype.html}
            // 只读预览：仅 allow-scripts，不开放表单提交/导航等，原型不可编辑。
            sandbox="allow-scripts"
            className="h-full w-full border-0 bg-white"
          />
        ) : null}
      </main>
    </div>
  );
}

function sectionBlocks(section: ShareSection) {
  const blocks = Array.isArray(section.blocks)
    ? section.blocks.filter((block) => block.content)
    : [];
  return blocks.length
    ? blocks
    : section.content
      ? [{ id: section.id ? `${section.id}:body` : undefined, type: "paragraph", content: section.content }]
      : [];
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-full px-3 py-1 font-medium transition",
        active ? "bg-gray-900 text-white" : "text-gray-600 hover:text-gray-900",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function CenteredNotice({
  title,
  subtitle,
  tone = "neutral",
}: {
  title: string;
  subtitle: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6">
      <div className="max-w-sm text-center">
        <div
          className={[
            "text-base font-semibold",
            tone === "error" ? "text-red-600" : "text-gray-900",
          ].join(" ")}
        >
          {title}
        </div>
        <div className="mt-1 text-sm text-gray-500">{subtitle}</div>
      </div>
    </div>
  );
}
