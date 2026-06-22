"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  Crop,
  FileText,
  MessageSquare,
  ShieldAlert,
} from "lucide-react";
import { SegmentedControl } from "@/components/ui";
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
  prdPreview,
  prototypePreview,
  decision,
}: {
  prdPreview?: Phase1PrdPreview | null;
  prototypePreview?: Phase1PrototypePreview | null;
  decision?: Phase2DecisionView | null;
}) {
  const [mode, setMode] = useState<PreviewMode>("prototype");
  const activeTab = PREVIEW_TABS.find((tab) => tab.value === mode) ?? PREVIEW_TABS[1];

  useEffect(() => {
    if (prototypePreview?.html) {
      setMode("prototype");
      return;
    }
    if (prdPreview) {
      setMode("prd");
    }
  }, [prdPreview?.id, prototypePreview?.id, prototypePreview?.html]);

  return (
    <aside className="flex min-h-0 min-w-0 flex-col bg-[var(--color-panel-bg)]">
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-950">结果预览</div>
          <div className="truncate text-xs text-gray-500">{activeTab.description}</div>
        </div>
        <SegmentedControl
          value={mode}
          onChange={setMode}
          ariaLabel="结果预览切换"
          className="max-w-[360px] overflow-x-auto"
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
