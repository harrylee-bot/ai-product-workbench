"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  Code2,
  Crop,
  FileDown,
  FileText,
  MessageSquare,
  ShieldAlert,
} from "lucide-react";
import { IconButton, SegmentedControl } from "@/components/ui";
import { downloadApiFile } from "@/lib/api";
import { FeedbackWorkflowView } from "./feedback-workflow-view";
import { PrdPreviewView } from "./prd-preview-view";
import { PrototypePreviewView } from "./prototype-preview-view";
import { QaPreviewView } from "./qa-preview-view";
import { StatePreviewView } from "./state-preview-view";
import type {
  Phase1PrdPreview,
  Phase1PrototypePreview,
  Phase2DecisionView,
  PreviewMode,
} from "./types";

const PREVIEW_TABS: Array<{ value: PreviewMode; label: string; icon: typeof FileText; description: string }> = [
  { value: "prd", label: "PRD", icon: FileText, description: "文档阅读与段落编辑" },
  { value: "prototype", label: "原型", icon: Crop, description: "画布选区与局部补丁" },
  { value: "qa", label: "QA", icon: ShieldAlert, description: "问题严重程度与回归" },
  { value: "state", label: "状态", icon: Activity, description: "指标、推断与版本" },
  { value: "feedback", label: "反馈", icon: MessageSquare, description: "反馈闭环工作流" },
];

export function PreviewPanel({
  projectId,
  prdPreview,
  prototypePreview,
  decision,
}: {
  projectId?: string;
  prdPreview?: Phase1PrdPreview | null;
  prototypePreview?: Phase1PrototypePreview | null;
  decision?: Phase2DecisionView | null;
}) {
  const [mode, setMode] = useState<PreviewMode>("prototype");
  const [exporting, setExporting] = useState<"word" | "html" | null>(null);
  const activeTab = PREVIEW_TABS.find((tab) => tab.value === mode) ?? PREVIEW_TABS[1];
  const canExportPrd = Boolean(projectId && prdPreview?.id);
  const canExportHtml = Boolean(projectId && prototypePreview?.html);

  useEffect(() => {
    if (prototypePreview?.html) {
      setMode("prototype");
      return;
    }
    if (prdPreview) {
      setMode("prd");
    }
  }, [prdPreview?.id, prototypePreview?.id, prototypePreview?.html]);

  const handleExport = async (format: "word" | "html") => {
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

  return (
    <aside className="flex min-h-0 min-w-0 flex-col bg-[var(--color-panel-bg)]">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-950">结果预览</div>
          <div className="truncate text-xs text-gray-500">{activeTab.description}</div>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <div className="flex shrink-0 items-center gap-1">
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
            <PrdPreviewView prdPreview={prdPreview} />
          </div>
        ) : mode === "prototype" ? (
          <PrototypePreviewView prototypePreview={prototypePreview} />
        ) : mode === "qa" ? (
          <QaPreviewView decision={decision} />
        ) : mode === "state" ? (
          <StatePreviewView decision={decision} prdPreview={prdPreview} prototypePreview={prototypePreview} />
        ) : (
          <FeedbackWorkflowView decision={decision} />
        )}
      </div>
    </aside>
  );
}
