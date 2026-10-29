"use client";

import { PaletteIcon, XIcon } from "lucide-react";
import { motion } from "framer-motion";

import { Switch } from "@/components/ui/switch";
import type { PrototypeCanvasStyleDraft } from "@/lib/workbench/features/prototype-style";
import { cn } from "@/lib/utils";

const workbenchEase = [0.16, 1, 0.3, 1] as const;

export type WorkbenchCanvasDesignSystemDraft = PrototypeCanvasStyleDraft;

export const workbenchCanvasDesignSystemPalette = [
  "#121315",
  "#202124",
  "#8758f6",
  "#f1f3f4",
] as const;

export function WorkbenchCanvasDesignSystemPanel({
  busy = false,
  draft,
  error = null,
  onChange,
  onClose,
  readOnly = false,
}: {
  busy?: boolean;
  draft: WorkbenchCanvasDesignSystemDraft;
  error?: string | null;
  onChange: (draft: WorkbenchCanvasDesignSystemDraft) => void;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const locked = busy || readOnly;
  const update = (patch: Partial<WorkbenchCanvasDesignSystemDraft>) => {
    if (locked) return;
    onChange({ ...draft, ...patch });
  };

  return (
    <motion.aside
      animate={{ opacity: 1, scale: 1, x: 0, y: "-50%" }}
      aria-busy={busy}
      aria-label="Design system"
      aria-readonly={readOnly}
      className="absolute right-[80px] top-1/2 z-50 w-[292px] overflow-hidden rounded-[20px] border border-white/[0.12] bg-[#202124]/98 p-[13px] text-[#f1f3f4] shadow-[0_26px_80px_-36px_rgba(0,0,0,0.98)] backdrop-blur-xl max-sm:right-[64px] max-sm:w-[min(292px,calc(100vw-80px))]"
      data-workbench-canvas-design-system-panel
      initial={{ opacity: 0, scale: 0.97, x: 8, y: "-50%" }}
      transition={{ duration: 0.18, ease: workbenchEase }}
    >
      <header className="flex h-[42px] items-center gap-[10px] px-[2px]">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-[#f1f3f4] text-[#202124]">
          <PaletteIcon className="size-[17px]" />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block text-[14px] font-semibold leading-[18px]">Design system</strong>
          <span className="block text-[13px] leading-[17px] text-[#aeb3bb]">调整颜色和排版</span>
        </span>
        <button
          aria-label="关闭 Design system"
          className="grid size-[30px] place-items-center rounded-full text-[#b5bac2] transition-colors hover:bg-white/[0.07] hover:text-white"
          disabled={busy}
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-[16px]" />
        </button>
      </header>

      <div className="mt-[8px] space-y-[8px]">
        <DesignSystemSettingRow
          description="产品工作台深色画布"
          label="Theme"
        >
          <button
            aria-label="切换主题"
            aria-pressed={draft.theme === "dark"}
            className={cn(
              "h-[24px] min-w-[42px] rounded-full px-[9px] text-[12px] font-semibold transition-colors",
              draft.theme === "dark"
                ? "bg-[#c9b3ff] text-[#31254b]"
                : "bg-[#f1f3f4] text-[#202124]",
            )}
            disabled={locked}
            onClick={() => update({ theme: draft.theme === "dark" ? "light" : "dark" })}
            type="button"
          >
            {draft.theme === "dark" ? "Dark" : "Light"}
          </button>
        </DesignSystemSettingRow>

        <DesignSystemSettingRow description="紧凑圆角" label="Radius">
          <label className="relative block h-[26px] w-[38px]">
            <span className="sr-only">圆角</span>
            <input
              aria-label="圆角"
              className="h-[26px] w-[38px] appearance-none rounded-full border-0 bg-white/[0.09] px-[6px] text-center text-[12px] font-medium text-[#d9dde3] outline-none focus:ring-1 focus:ring-[#9d78ff]"
              disabled={locked}
              inputMode="numeric"
              max={32}
              min={0}
              onChange={(event) => update({ radius: clampRadius(event.currentTarget.value) })}
              type="number"
              value={draft.radius}
            />
          </label>
        </DesignSystemSettingRow>

        <DesignSystemSettingRow description="柔和弹出" label="Motion">
          <Switch
            aria-label="Motion"
            checked={draft.motionEnabled}
            disabled={locked}
            onCheckedChange={(checked) => update({ motionEnabled: checked })}
          />
        </DesignSystemSettingRow>
      </div>

      <section className="mt-[13px] rounded-[15px] border border-white/[0.09] bg-[#17181a] p-[12px]">
        <div className="mb-[10px] flex items-center justify-between text-[13px]">
          <span className="font-medium text-[#dfe3e8]">Theme</span>
          <span className="text-[#c5cad1]">{draft.theme === "dark" ? "Dark" : "Light"}</span>
        </div>
        <div className="grid grid-cols-4 gap-[8px]">
          {workbenchCanvasDesignSystemPalette.map((color) => (
            <button
              aria-label={`颜色 ${color}`}
              aria-pressed={draft.color.toLowerCase() === color}
              className={cn(
                "h-[72px] rounded-[11px] border transition-[border-color,box-shadow,transform]",
                draft.color.toLowerCase() === color
                  ? "border-[#a985ff] shadow-[0_0_0_1px_rgba(169,133,255,0.32)]"
                  : "border-white/[0.08] hover:border-white/[0.18]",
                "active:scale-[0.97]",
              )}
              disabled={locked}
              key={color}
              onClick={() => update({ color })}
              style={{ backgroundColor: color }}
              type="button"
            />
          ))}
        </div>
      </section>

      {error && (
        <p className="mt-[10px] rounded-[10px] border border-[#d96868]/35 bg-[#6e2525]/18 px-[10px] py-[8px] text-[12px] leading-[16px] text-[#f0aaaa]" role="alert">
          {error}
        </p>
      )}
    </motion.aside>
  );
}

function DesignSystemSettingRow({
  children,
  description,
  label,
}: {
  children: React.ReactNode;
  description: string;
  label: string;
}) {
  return (
    <div className="flex min-h-[58px] items-center rounded-[14px] border border-white/[0.08] bg-white/[0.025] px-[12px]">
      <span className="min-w-0 flex-1">
        <strong className="block text-[13px] font-semibold leading-[17px] text-[#f1f3f4]">{label}</strong>
        <span className="block truncate text-[12px] leading-[16px] text-[#969ca5]">{description}</span>
      </span>
      {children}
    </div>
  );
}

function clampRadius(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(32, Math.max(0, Math.round(parsed)));
}
