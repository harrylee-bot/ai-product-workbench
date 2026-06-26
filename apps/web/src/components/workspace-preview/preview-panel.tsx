"use client";

import { useEffect, useRef, useState } from "react";
import {
  Code2,
  Crop,
  FileDown,
  FileText,
  GitBranch,
  Share2,
} from "lucide-react";
import { Modal } from "@/components/modal";
import { Button, IconButton, SegmentedControl, Select } from "@/components/ui";
import { apiRequest, downloadApiFile } from "@/lib/api";
import { CanvasPreviewView } from "./canvas-preview-view";
import { PrdPreviewView } from "./prd-preview-view";
import { PrototypePreviewView } from "./prototype-preview-view";
import type {
  Phase1PrdPreview,
  Phase1PrototypePreview,
  DocumentCanvasPreview,
  PreviewMode,
} from "./types";

const PREVIEW_TABS: Array<{ value: PreviewMode; label: string; icon: typeof FileText; description: string }> = [
  { value: "prd", label: "PRD", icon: FileText, description: "文档阅读与段落编辑" },
  { value: "canvas", label: "Canvas", icon: GitBranch, description: "文档结构画布" },
  { value: "prototype", label: "原型", icon: Crop, description: "网页原型预览" },
];

type ShareScope = "prd" | "prototype" | "both";

export function PreviewPanel({
  projectId,
  prdPreview,
  prototypePreview,
  savingPrdSectionId,
  onSavePrdSection,
}: {
  projectId?: string;
  prdPreview?: Phase1PrdPreview | null;
  prototypePreview?: Phase1PrototypePreview | null;
  savingPrdSectionId?: string;
  onSavePrdSection?: (input: { sectionId: string; content: string }) => Promise<void> | void;
}) {
  const [mode, setMode] = useState<PreviewMode>("prd");
  const userPickedRef = useRef(false);
  const [exporting, setExporting] = useState<"word" | "html" | "canvas" | null>(null);
  const [canvasPreview, setCanvasPreview] = useState<DocumentCanvasPreview | null>(null);
  const [canvasLoading, setCanvasLoading] = useState(false);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [notice, setNotice] = useState<{ title: string; message: string } | null>(null);
  const activeTab = PREVIEW_TABS.find((tab) => tab.value === mode) ?? PREVIEW_TABS[1];
  const canExportPrd = Boolean(projectId && prdPreview?.id);
  const canExportCanvas = Boolean(projectId && prdPreview?.id);
  const canExportHtml = Boolean(projectId && prototypePreview?.html);
  const hasShareablePrd = Boolean(prdPreview?.id);
  const hasShareablePrototype = Boolean(prototypePreview?.html);
  const canShare = Boolean(projectId && (hasShareablePrd || hasShareablePrototype));
  const availableShareScopes = shareScopeOptions(hasShareablePrd, hasShareablePrototype);
  const defaultShareScope = deriveShareScope(hasShareablePrd, hasShareablePrototype);
  const [shareScope, setShareScope] = useState<ShareScope>(defaultShareScope);
  const effectiveShareScope = availableShareScopes.some((option) => option.value === shareScope)
    ? shareScope
    : defaultShareScope;

  // 用户手动切换 tab 后，后续产物到达不再抢占焦点。
  const handleTabChange = (next: PreviewMode) => {
    userPickedRef.current = true;
    setMode(next);
  };

  useEffect(() => {
    setShareScope(defaultShareScope);
  }, [defaultShareScope]);

  // 仅在「尚未生成产物」阶段自动跟随：原型到达时切到原型（确认 PRD 后看原型），
  // 否则默认停留在 PRD。用户一旦手动切过，就不再抢占。
  useEffect(() => {
    if (userPickedRef.current) return;
    if (prototypePreview?.html) {
      setMode("prototype");
      return;
    }
    if (prdPreview) {
      setMode("prd");
    }
  }, [prdPreview?.id, prototypePreview?.id, prototypePreview?.html, prdPreview]);

  useEffect(() => {
    setCanvasPreview(null);
    setCanvasError(null);
  }, [prdPreview?.id]);

  useEffect(() => {
    if (mode !== "canvas" || !prdPreview?.id || canvasPreview || canvasLoading || canvasError) return;
    let active = true;
    setCanvasLoading(true);
    setCanvasError(null);
    apiRequest<DocumentCanvasPreview>(`/prd-documents/${encodeURIComponent(prdPreview.id)}/canvas`)
      .then((response) => {
        if (active) setCanvasPreview(response);
      })
      .catch((error) => {
        if (active) setCanvasError(error instanceof Error ? error.message : "Canvas 生成失败");
      })
      .finally(() => {
        if (active) setCanvasLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canvasError, canvasLoading, canvasPreview, mode, prdPreview?.id]);

  const handleExport = async (format: "word" | "html" | "canvas") => {
    if (!projectId || exporting) return;
    setExporting(format);
    try {
      await downloadApiFile(`/projects/${projectId}/export/${format}`);
    } catch (error) {
      setNotice({ title: "文件导出失败", message: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setExporting(null);
    }
  };

  const handleShare = async () => {
    if (!projectId || sharing) return;
    setSharing(true);
    setShareCopied(false);
    try {
      const response = await apiRequest<{ share: { url: string } }>("/share-links", {
        method: "POST",
        body: JSON.stringify({ projectId, scope: effectiveShareScope }),
      });
      const shareUrl = absoluteShareUrl(response.share.url);
      await copyText(shareUrl);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 2400);
    } catch (error) {
      setNotice({ title: "分享链接创建失败", message: error instanceof Error ? error.message : "请稍后重试" });
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <aside className="flex min-h-0 min-w-0 flex-col bg-[var(--color-panel-bg)]">
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-950">结果预览</div>
            <div className="truncate text-xs text-gray-500">{activeTab.description}</div>
          </div>
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <div className="flex shrink-0 items-center gap-1">
              {availableShareScopes.length > 1 ? (
                <Select
                  aria-label="分享范围"
                  value={effectiveShareScope}
                  onChange={(event) => setShareScope(event.target.value as ShareScope)}
                  className="h-9 max-w-[116px] px-2 text-xs"
                  disabled={sharing}
                >
                  {availableShareScopes.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              ) : null}
              <IconButton
                label="导出 PRD Word"
                variant="secondary"
                disabled={!canExportPrd || exporting !== null}
                onClick={() => handleExport("word")}
              >
                <FileDown className="h-4 w-4" />
              </IconButton>
              <IconButton
                label="导出 HTML 原型"
                variant="secondary"
                disabled={!canExportHtml || exporting !== null}
                onClick={() => handleExport("html")}
              >
                <Code2 className="h-4 w-4" />
              </IconButton>
              <IconButton
                label="导出 PRD Canvas"
                variant="secondary"
                disabled={!canExportCanvas || exporting !== null}
                onClick={() => handleExport("canvas")}
              >
                <GitBranch className="h-4 w-4" />
              </IconButton>
              <IconButton
                label={shareCopied ? "分享链接已复制" : "创建只读分享链接"}
                variant="secondary"
                disabled={!canShare || sharing}
                onClick={handleShare}
              >
                <Share2 className="h-4 w-4" />
              </IconButton>
            </div>
            <SegmentedControl
              value={mode}
              onChange={handleTabChange}
              ariaLabel="结果预览切换"
              className="min-w-0 max-w-[360px] overflow-x-auto"
              options={PREVIEW_TABS.map((tab) => {
                const Icon = tab.icon;
                return {
                  value: tab.value,
                  label: tab.label,
                  icon: <Icon className="h-3.5 w-3.5" />,
                };
              })}
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {mode === "prd" ? (
            <div className="workbench-scrollbar h-full overflow-y-auto p-2.5">
              <PrdPreviewView
                prdPreview={prdPreview}
                savingSectionId={savingPrdSectionId}
                onSaveSection={onSavePrdSection}
              />
            </div>
          ) : mode === "canvas" ? (
            <CanvasPreviewView
              prdPreview={prdPreview}
              canvasPreview={canvasPreview}
              loading={canvasLoading}
              error={canvasError}
            />
          ) : (
            <PrototypePreviewView prototypePreview={prototypePreview} />
          )}
        </div>
      </aside>
      <Modal
        open={Boolean(notice)}
        title={notice?.title ?? "操作失败"}
        onClose={() => setNotice(null)}
        footer={(
          <Button type="button" onClick={() => setNotice(null)}>
            知道了
          </Button>
        )}
      >
        <p className="text-sm leading-6 text-gray-600">{notice?.message}</p>
      </Modal>
    </>
  );
}

function shareScopeOptions(hasPrd: boolean, hasPrototype: boolean): Array<{ value: ShareScope; label: string }> {
  if (hasPrd && hasPrototype) {
    return [
      { value: "both", label: "两者" },
      { value: "prd", label: "PRD" },
      { value: "prototype", label: "原型" },
    ];
  }
  if (hasPrd) return [{ value: "prd", label: "PRD" }];
  if (hasPrototype) return [{ value: "prototype", label: "原型" }];
  return [{ value: "both", label: "两者" }];
}

function deriveShareScope(hasPrd: boolean, hasPrototype: boolean): ShareScope {
  if (hasPrd && hasPrototype) return "both";
  if (hasPrd) return "prd";
  return "prototype";
}

function absoluteShareUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const element = document.createElement("textarea");
  element.value = value;
  element.setAttribute("readonly", "true");
  element.style.position = "fixed";
  element.style.left = "-9999px";
  document.body.appendChild(element);
  element.select();
  document.execCommand("copy");
  document.body.removeChild(element);
}
