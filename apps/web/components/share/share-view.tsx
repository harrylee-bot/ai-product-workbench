"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Clock, Eye, FileText, Layout, Share2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { getApiBase } from "@/lib/api/config";

interface ShareViewProps {
  shareData: {
    title: string;
    scope: "prd" | "prototype" | "both";
    readOnly: boolean;
    allowDownload: boolean;
    allowEdit: boolean;
    expiresAt?: string | null;
    prd?: {
      title: string;
      sections: Array<{
        id: string;
        title: string;
        content: string;
        type: string;
        level: number;
      }>;
      updatedAt: string;
    };
    prototype?: {
      title: string;
      previewUrl?: string;
      pageCount?: number;
      updatedAt: string;
    };
  };
  token: string;
}

export function ShareView({ shareData, token }: ShareViewProps) {
  const [activeView, setActiveView] = useState<"prd" | "prototype">(
    shareData.scope === "prd" ? "prd" : shareData.scope === "prototype" ? "prototype" : "prd"
  );

  const showPRD = shareData.scope === "prd" || shareData.scope === "both";
  const showPrototype = shareData.scope === "prototype" || shareData.scope === "both";
  const prototypePreviewUrl = shareData.prototype?.previewUrl
    ? toApiUrl(shareData.prototype.previewUrl)
    : `${getApiBase()}/authenticated-share/${encodeURIComponent(token)}/prototype`;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-white shadow-sm">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Share2 className="size-6 text-blue-600" />
            <div className="min-w-0">
              <h1 className="break-words text-lg font-semibold">{shareData.title}</h1>
              <p className="text-sm text-muted-foreground">只读分享</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="flex items-center gap-1">
              <Eye className="size-3" />
              只读模式
            </Badge>
            {shareData.expiresAt && (
              <Badge variant="secondary" className="flex items-center gap-1">
                <Clock className="size-3" />
                {new Date(shareData.expiresAt).toLocaleDateString("zh-CN")}
              </Badge>
            )}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-7xl px-4 py-6">
        {/* View Switcher */}
        {showPRD && showPrototype && (
          <div className="mb-4 inline-flex rounded-lg bg-muted p-1">
            <button
              onClick={() => setActiveView("prd")}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                activeView === "prd"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <FileText className="size-4" />
              需求文档
            </button>
            <button
              onClick={() => setActiveView("prototype")}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                activeView === "prototype"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Layout className="size-4" />
              原型
            </button>
          </div>
        )}

        {/* PRD View */}
        {showPRD && activeView === "prd" && shareData.prd && (
          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <div className="mb-6 border-b pb-4">
              <h2 className="text-2xl font-bold">{shareData.prd.title}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                最后更新：{new Date(shareData.prd.updatedAt).toLocaleString("zh-CN")}
              </p>
            </div>
            <div className="prose prose-sm max-w-none">
              {shareData.prd.sections.map((section, index) => (
                <motion.div
                  key={section.id ?? `${section.title}-${index}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3 }}
                  className="mb-6"
                >
                  {section.level === 1 && (
                    <h1 className="text-2xl font-bold mb-3">{section.title}</h1>
                  )}
                  {section.level === 2 && (
                    <h2 className="text-xl font-semibold mb-2">{section.title}</h2>
                  )}
                  {section.level === 3 && (
                    <h3 className="text-lg font-medium mb-2">{section.title}</h3>
                  )}
                  <div className="text-sm text-gray-700 whitespace-pre-wrap">
                    {section.content}
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        )}

        {/* Prototype View */}
        {showPrototype && activeView === "prototype" && shareData.prototype && (
          <div className="rounded-lg border bg-white p-6 shadow-sm">
            <div className="mb-6 border-b pb-4">
              <h2 className="text-2xl font-bold">{shareData.prototype.title}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                页面数：{shareData.prototype.pageCount ?? 1} · 最后更新：
                {new Date(shareData.prototype.updatedAt).toLocaleString("zh-CN")}
              </p>
            </div>
            <div className="rounded-lg border bg-white">
              <iframe
                title="原型预览"
                sandbox=""
                src={prototypePreviewUrl}
                className="h-[70vh] min-h-[520px] w-full border-0"
              />
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t bg-white py-4 mt-8">
        <div className="mx-auto max-w-7xl px-4 text-center text-sm text-muted-foreground">
          <p>此页面为只读分享，不支持编辑和下载</p>
        </div>
      </footer>
    </div>
  );
}

function toApiUrl(path: string) {
  if (/^https?:\/\//.test(path)) return path;
  if (path.startsWith("/api/")) return `${getApiBase()}${path.slice(4)}`;
  return path;
}
