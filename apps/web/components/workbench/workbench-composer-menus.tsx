"use client";

import { motion } from "framer-motion";
import {
  CheckCircle2Icon,
  FileTextIcon,
  FrameIcon,
  Link2Icon,
  ImageIcon,
  MonitorIcon,
  SparklesIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";
import type { WorkbenchComposerAttachmentKind } from "@/lib/workbench/files/composer-attachments";
import type { WorkbenchModelChoice } from "@/lib/workbench/features";

import { popoverTransition } from "./workbench-motion";

type ModelName = string;

export function ComposerCommandMenu({
  onSelect,
  placement = "project",
}: {
  onSelect: (value: string) => void;
  placement?: "home" | "project";
}) {
  const commands = [
    { icon: SparklesIcon, label: "生成 UI 界面设计", value: "基于此 PRD 生成 UI 界面设计" },
    { icon: FileTextIcon, label: "继续完善需求文档", value: "细化补签和奖励规则" },
    { icon: FrameIcon, label: "整理为多屏流程", value: "把当前设计整理成多屏流程" },
  ];

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "absolute w-[254px] overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#18191b]/94 p-[7px] text-[#e8eaed] shadow-[0_22px_80px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl",
        placement === "home" ? "bottom-[68px] left-[54px]" : "bottom-[42px] left-[54px]",
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
            className="flex h-[38px] w-full items-center gap-[10px] rounded-[9px] px-[10px] text-left text-[12px] font-semibold text-[#f1f3f4] hover:bg-white/[0.06]"
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
  placement = "project",
}: {
  onSelect?: (kind: WorkbenchComposerAttachmentKind | "source") => void;
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
        "absolute w-[184px] overflow-hidden rounded-[14px] border border-white/[0.08] bg-[#18191b]/94 p-[7px] text-[#e8eaed] shadow-[0_22px_80px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl",
        placement === "home"
          ? "bottom-[68px] left-[16px]"
          : "bottom-[42px] right-[202px] max-sm:left-0 max-sm:right-auto",
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
            className="flex h-[38px] w-full items-center gap-[10px] rounded-[9px] px-[10px] text-left text-[12px] font-semibold text-[#f1f3f4] hover:bg-white/[0.06]"
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
    </motion.div>
  );
}

export function ModelChoiceMenu({
  className,
  model,
  modelChoices,
  onSelectModel,
}: {
  className: string;
  model: ModelName;
  modelChoices: WorkbenchModelChoice[];
  onSelectModel: (model: ModelName) => void;
}) {
  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn("z-[70] overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#18191b]/92 p-[8px] text-[#e8eaed] shadow-[0_24px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl", className)}
      exit={{ opacity: 0, y: 3 }}
      initial={{ opacity: 0, y: 5 }}
      transition={popoverTransition}
    >
      {modelChoices.map((option) => (
        <button
          className={cn(
            "flex min-h-[68px] w-full items-center gap-[12px] rounded-[8px] px-[12px] py-[10px] text-left hover:bg-white/[0.06]",
            model === option.key && "bg-white/[0.10]",
          )}
          key={option.key}
          onClick={() => onSelectModel(option.key)}
          type="button"
        >
          <SparklesIcon className="size-[18px] shrink-0 text-[#f1f3f4]" />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold leading-[18px]">{option.label}</span>
            <span className="mt-[4px] block whitespace-normal text-[12px] leading-[17px] text-[#c4c7ce]">{option.description}</span>
          </span>
          {model === option.key && <CheckCircle2Icon className="size-[16px] shrink-0 text-[#e8eaed]" />}
        </button>
      ))}
    </motion.div>
  );
}
