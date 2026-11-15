"use client";

import { motion } from "framer-motion";
import {
  CheckCircle2Icon,
  FileTextIcon,
  FrameIcon,
  Code2Icon,
  Link2Icon,
  ImageIcon,
  MonitorIcon,
  SparklesIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";
import type { WorkbenchComposerAttachmentKind } from "@/lib/workbench/files/composer-attachments";

import { popoverTransition } from "./workbench-motion";


export type WorkbenchArtifactOutputKind = "both" | "prd" | "prototype";

export function artifactKindsForOutput(kind: WorkbenchArtifactOutputKind): Array<"prd" | "prototype"> {
  return kind === "both" ? ["prd", "prototype"] : [kind];
}

export function artifactOutputLabel(kind: WorkbenchArtifactOutputKind): string {
  return kind === "both" ? "需求文档＋原型" : kind === "prd" ? "生成文档" : "生成原型";
}

export function ComposerArtifactOutputMenu({
  kind,
  onSelect,
  placement = "project",
  models = [],
  selectedModelId,
  onSelectModel,
}: {
  kind: WorkbenchArtifactOutputKind | null;
  onSelect: (kind: WorkbenchArtifactOutputKind) => void;
  placement?: "home" | "project";
  models?: readonly string[];
  selectedModelId?: string;
  onSelectModel?: (modelId: string) => void;
}) {
  const options = [
    { icon: SparklesIcon, kind: "both" as const, label: "需求文档＋原型", description: "生成关联的文档与可交互原型" },
    { icon: FileTextIcon, kind: "prd" as const, label: "生成文档", description: "输出需求说明书" },
    { icon: FrameIcon, kind: "prototype" as const, label: "生成原型", description: "输出可交互原型" },
  ];

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "absolute z-[70] w-[240px] max-w-[calc(100vw-64px)] max-h-[min(360px,calc(100dvh-120px))] overflow-y-auto rounded-[10px] border border-white/[0.08] bg-[#18191b]/94 p-[8px] text-[#e8eaed] shadow-[0_24px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl",
        placement === "home" ? "right-0 bottom-[160px] md:bottom-[112px]" : "bottom-[78px] right-0 md:bottom-[42px] md:right-[202px]",
      )}
      exit={{ opacity: 0, y: 3 }}
      initial={{ opacity: 0, y: 5 }}
      role="menu"
      transition={popoverTransition}
    >
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            aria-pressed={kind === option.kind}
            className={cn(
              "flex min-h-[58px] w-full items-center gap-[10px] rounded-[8px] px-[10px] py-[8px] text-left hover:bg-white/[0.06]",
              kind === option.kind && "bg-white/[0.10]",
            )}
            key={option.kind}
            onClick={() => onSelect(option.kind)}
            role="menuitemradio"
            type="button"
          >
            <Icon className="size-[17px] shrink-0 text-[#f1f3f4]" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold leading-[17px]">{option.label}</span>
              <span className="mt-[2px] block text-[12px] leading-[15px] text-[#aeb3bb]">{option.description}</span>
            </span>
            {kind === option.kind && <CheckCircle2Icon className="size-[15px] shrink-0 text-[#e8eaed]" />}
          </button>
        );
      })}
      {models.length > 0 && onSelectModel && <div className="mt-2 border-t border-white/[0.08] pt-2">
        <p className="px-2 pb-1 text-xs text-[#9aa0a6]">生成模型</p>
        {models.map((modelId) => <button key={modelId} type="button" role="menuitemradio" aria-checked={modelId === selectedModelId} onClick={() => onSelectModel(modelId)} className="flex min-h-10 w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-xs hover:bg-white/[0.06]">
          <span className="min-w-0 break-all">{modelId}</span>{modelId === selectedModelId && <CheckCircle2Icon className="size-4 shrink-0" />}
        </button>)}
      </div>}
    </motion.div>
  );
}

export function ComposerCommandMenu({
  onSelect,
  placement = "project",
}: {
  onSelect: (value: string) => void;
  placement?: "home" | "project";
}) {
  const commands = [
    { icon: SparklesIcon, label: "生成 UI 界面设计", value: "基于此 PRD 生成 UI 界面设计" },
    { icon: FileTextIcon, label: "继续完善需求文档", value: "继续完善当前需求文档，细化业务规则并补充异常场景和验收标准" },
    { icon: FrameIcon, label: "整理为多屏流程", value: "把当前设计整理成多屏流程" },
  ];

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "absolute w-[254px] max-w-full overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#18191b]/94 p-[7px] text-[#e8eaed] shadow-[0_22px_80px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl",
        placement === "home" ? "bottom-[160px] left-0 md:bottom-[112px]" : "bottom-[78px] left-0 md:bottom-[42px] md:left-[54px]",
      )}
      exit={{ opacity: 0, y: 3 }}
      initial={{ opacity: 0, y: 5 }}
      role="menu"
      transition={popoverTransition}
    >
      {commands.map((command) => {
        const Icon = command.icon;
        return (
          <button
            className="flex h-[38px] w-full items-center gap-[10px] rounded-[9px] px-[10px] text-left text-[13px] font-semibold text-[#f1f3f4] hover:bg-white/[0.06]"
            key={command.label}
            onClick={() => onSelect(command.value)}
            role="menuitem"
            type="button"
          >
            <Icon className="size-[15px] shrink-0 text-[#d8dce2]" />
            {command.label}
          </button>
        );
      })}
    </motion.div>
  );
}

export function ComposerAttachmentMenu({
  onSelect,
  onImportSourcePrototype,
  placement = "project",
}: {
  onSelect?: (kind: WorkbenchComposerAttachmentKind | "source") => void;
  onImportSourcePrototype?: () => void;
  placement?: "home" | "project";
}) {
  const items = [
    { icon: ImageIcon, kind: "image", label: "添加图片" },
    { icon: FileTextIcon, kind: "document", label: "添加文档" },
    { icon: MonitorIcon, kind: "screen", label: "添加屏幕截图" },
    { icon: Link2Icon, kind: "source", label: "添加网站 / GitHub / Figma" },
  ] satisfies Array<{
    icon: ComponentType<{ className?: string }>;
    kind: WorkbenchComposerAttachmentKind | "source";
    label: string;
  }>;

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "absolute w-[264px] max-w-full overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#18191b]/94 p-[7px] text-[#e8eaed] shadow-[0_22px_80px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl",
        placement === "home"
          ? "bottom-[160px] left-[16px] md:bottom-[112px]"
          : "bottom-[78px] left-0 md:bottom-[42px] md:left-auto md:right-[202px]",
      )}
      exit={{ opacity: 0, y: 3 }}
      initial={{ opacity: 0, y: 5 }}
      role="menu"
      transition={popoverTransition}
    >
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            className="flex h-[38px] w-full items-center gap-[10px] rounded-[9px] px-[10px] text-left text-[13px] font-semibold text-[#f1f3f4] hover:bg-white/[0.06]"
            key={item.label}
            onClick={() => onSelect?.(item.kind)}
            role="menuitem"
            type="button"
          >
            <Icon className="size-[15px] shrink-0 text-[#d8dce2]" />
            {item.label}
          </button>
        );
      })}
      {onImportSourcePrototype && <button className="flex h-[38px] w-full items-center gap-[10px] rounded-[9px] px-[10px] text-left text-[13px] font-semibold text-[#f1f3f4] hover:bg-white/[0.06]"
        onClick={onImportSourcePrototype} role="menuitem" type="button"><Code2Icon className="size-[15px] shrink-0 text-[#d8dce2]" />导入源码原型</button>}
    </motion.div>
  );
}
