"use client";

import type { RunTargetSurface } from "@workbench/workbench-contracts";
import { MonitorIcon, SmartphoneIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function WorkbenchTargetSurfaceControl({
  disabled = false,
  onChange,
  surface,
  variant = "composer",
}: {
  disabled?: boolean;
  onChange: (surface: RunTargetSurface) => void;
  surface: RunTargetSurface;
  variant?: "composer" | "panel";
}) {
  const panel = variant === "panel";

  return (
    <div
      aria-label="生成目标"
      className={cn(
        "flex h-[34px] shrink-0 items-center gap-[3px] rounded-full bg-[#121315]/80 p-[2px]",
        panel ? "mt-[10px] w-full" : "max-sm:w-[68px]",
      )}
      role="group"
    >
      <button
        aria-label="应用"
        aria-pressed={surface === "app"}
        className={cn(
          "workbench-composer-segment flex h-[30px] items-center justify-center gap-[6px] rounded-full px-[9px] text-[13px] font-semibold",
          panel && "flex-1 text-[12px]",
          !panel && "max-sm:flex-1 max-sm:px-0",
          surface === "app" ? "bg-[#3f4247]/90 text-[#f1f3f4]" : "text-[#bfc4ca]",
        )}
        disabled={disabled}
        onClick={() => onChange("app")}
        type="button"
      >
        <SmartphoneIcon className="size-[14px] shrink-0" />
        <span className={cn(!panel && "max-sm:hidden")}>应用</span>
      </button>
      <button
        aria-label="Web"
        aria-pressed={surface === "web"}
        className={cn(
          "workbench-composer-segment flex h-[30px] items-center justify-center gap-[6px] rounded-full px-[9px] text-[13px] font-semibold",
          panel && "flex-1 text-[12px]",
          !panel && "max-sm:flex-1 max-sm:px-0",
          surface === "web" ? "bg-[#3f4247]/90 text-[#f1f3f4]" : "text-[#bfc4ca]",
        )}
        disabled={disabled}
        onClick={() => onChange("web")}
        type="button"
      >
        <MonitorIcon className="size-[14px] shrink-0" />
        <span className={cn(!panel && "max-sm:hidden")}>Web</span>
      </button>
    </div>
  );
}
