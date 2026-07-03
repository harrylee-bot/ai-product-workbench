"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Clock, Eye, FileText, Layout, Share2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface ShareViewProps {
  shareData: {
    id: string;
    token: string;
    scope: "prd" | "prototype" | "both";
    expiresAt: string | null;
    isExpired: boolean;
    project: {
      id: string;
      name: string;
    };
    prdDocument?: {
      id: string;
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
    prototypeArtifact?: {
      id: string;
      title: string;
      htmlContent: string;
      targetDevice: string;
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

  if (shareData.isExpired) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="w-full max-w-md rounded-2xl border bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2 text-red-600">
            <Clock className="size-5" />
            <h1 className="text-lg font-semibold">分享链接已过期</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            此分享链接已于 {new Date(shareData.expiresAt!).toLocaleString("zh-CN")} 过期。
            请联系项目所有者重新生成分享链接。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b bg-white shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <Share2 className="size-6 text-blue-600" />
            <div>
              <h1 className="text-lg font-semibold">{shareData.project.name}</h1>
              <p className="text-sm text-muted-foreground">只读分享</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
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
        {showPRD && activeView === "prd" && shareData.prdDocument && (
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <div className="mb-6 border-b pb-4">
              <h2 className="text-2xl font-bold">{shareData.prdDocument.title}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                最后更新：{new Date(shareData.prdDocument.updatedAt).toLocaleString("zh-CN")}
              </p>
            </div>
            <div className="prose prose-sm max-w-none">
              {shareData.prdDocument.sections.map((section) => (
                <motion.div
                  key={section.id}
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
        {showPrototype && activeView === "prototype" && shareData.prototypeArtifact && (
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <div className="mb-6 border-b pb-4">
              <h2 className="text-2xl font-bold">{shareData.prototypeArtifact.title}</h2>
              <p className="text-sm text-muted-foreground mt-1">
                设备类型：{shareData.prototypeArtifact.targetDevice} · 最后更新：
                {new Date(shareData.prototypeArtifact.updatedAt).toLocaleString("zh-CN")}
              </p>
            </div>
            <div className="rounded-lg border bg-white">
              <iframe
                title="原型预览"
                sandbox="allow-scripts"
                srcDoc={shareData.prototypeArtifact.htmlContent}
                className="h-[800px] w-full border-0"
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
