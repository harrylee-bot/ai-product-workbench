"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  Code2,
  Crop,
  FileDown,
  FileText,
  GitBranch,
  MessageSquare,
  Share2,
  ShieldAlert,
} from "lucide-react";
import { IconButton, SegmentedControl, Select } from "@/components/ui";
import { apiRequest, downloadApiFile } from "@/lib/api";
import { CanvasPreviewView } from "./canvas-preview-view";
import { FeedbackWorkflowView } from "./feedback-workflow-view";
import { PrdPreviewView } from "./prd-preview-view";
import { PrototypePreviewView } from "./prototype-preview-view";
import { QaPreviewView } from "./qa-preview-view";
import { StatePreviewView } from "./state-preview-view";
import type {
  Phase1PrdPreview,
  Phase1PrototypePreview,
  DocumentCanvasPreview,
  PreviewMode,
  RuntimePatchPreview,
} from "./types";

const PREVIEW_TABS: Array<{ value: PreviewMode; label: string; icon: typeof FileText; description: string }> = [
  { value: "prd", label: "PRD", icon: FileText, description: "文档阅读与段落编辑" },
  { value: "canvas", label: "Canvas", icon: GitBranch, description: "文档结构画布" },
  { value: "prototype", label: "原型", icon: Crop, description: "画布选区与局部补丁" },
  { value: "qa", label: "QA", icon: ShieldAlert, description: "问题严重程度与回归" },
  { value: "state", label: "状态", icon: Activity, description: "指标、推断与版本" },
  { value: "feedback", label: "反馈", icon: MessageSquare, description: "反馈闭环工作流" },
];

type ShareScope = "prd" | "prototype" | "both";

export function PreviewPanel({
  projectId,
  prdPreview,
  prototypePreview,
  runtimePreview,
  savingPrdSectionId,
  aiEditingPrdSectionId,
  aiEditingPrototypeSelectionId,
  onSavePrdSection,
  onAiEditPrdSection,
  onAiEditPrototypeSelection,
}: {
  projectId?: string;
  prdPreview?: Phase1PrdPreview | null;
  prototypePreview?: Phase1PrototypePreview | null;
  runtimePreview?: RuntimePatchPreview | null;
  savingPrdSectionId?: string;
  aiEditingPrdSectionId?: string;
  aiEditingPrototypeSelectionId?: string;
  onSavePrdSection?: (input: { sectionId: string; content: string }) => Promise<void> | void;
  onAiEditPrdSection?: (input: {
    sectionId: string;
    blockId?: string;
    title: string;
    content: string;
    sourcePaths?: string[];
    instruction: string;
  }) => Promise<void> | void;
  onAiEditPrototypeSelection?: (input: {
    selectionId: string;
    componentId?: string;
    pageId?: string;
    action: string;
    instruction: string;
    bbox: { x: number; y: number; width: number; height: number };
    label: string;
  }) => Promise<void> | void;
}) {
  const [mode, setMode] = useState<PreviewMode>("prototype");
  const [exporting, setExporting] = useState<"word" | "html" | "canvas" | null>(null);
  const [canvasPreview, setCanvasPreview] = useState<DocumentCanvasPreview | null>(null);
  const [canvasLoading, setCanvasLoading] = useState(false);
  const [canvasError, setCanvasError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
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

  useEffect(() => {
    setShareScope(defaultShareScope);
  }, [defaultShareScope]);

  useEffect(() => {
    if (prototypePreview?.html) {
      setMode("prototype");
      return;
    }
    if (prdPreview) {
      setMode("prd");
    }
  }, [prdPreview?.id, prototypePreview?.id, prototypePreview?.html]);

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
      window.alert(error instanceof Error ? error.message : "文件导出失败");
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
      window.alert(error instanceof Error ? error.message : "分享链接创建失败");
    } finally {
      setSharing(false);
    }
  };

  return (
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
            onChange={setMode}
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
              aiEditingSectionId={aiEditingPrdSectionId}
              onSaveSection={onSavePrdSection}
              onAiEditSection={onAiEditPrdSection}
            />
          </div>
        ) : mode === "canvas" ? (
          <CanvasPreviewView
            prdPreview={prdPreview}
            canvasPreview={canvasPreview}
            loading={canvasLoading}
            error={canvasError}
          />
        ) : mode === "prototype" ? (
          <PrototypePreviewView
            prototypePreview={prototypePreview}
            aiEditingSelectionId={aiEditingPrototypeSelectionId}
            onAiEditSelection={onAiEditPrototypeSelection}
          />
        ) : mode === "qa" ? (
          <QaPreviewView runtimePreview={runtimePreview} />
        ) : mode === "state" ? (
          <StatePreviewView runtimePreview={runtimePreview} prdPreview={prdPreview} prototypePreview={prototypePreview} />
        ) : (
          <FeedbackWorkflowView runtimePreview={runtimePreview} />
        )}
      </div>
    </aside>
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
