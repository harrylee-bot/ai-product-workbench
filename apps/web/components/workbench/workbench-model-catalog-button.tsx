"use client";

import { ChevronDownIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isWorkbenchApiError } from "@/lib/workbench/api";
import type { WorkbenchModelCatalogState } from "@/lib/workbench/features";

export function WorkbenchModelCatalogButton({
  catalog,
  chevronClassName = "size-[14px]",
  className,
  disabled = false,
  leadingIcon,
  menuOpen,
  onRetry,
  onToggle,
  selectedLabel,
}: {
  catalog: WorkbenchModelCatalogState;
  chevronClassName?: string;
  className: string;
  disabled?: boolean;
  leadingIcon?: ReactNode;
  menuOpen: boolean;
  onRetry: () => void;
  onToggle: () => void;
  selectedLabel?: string;
}) {
  const presentation = modelCatalogButtonPresentation(catalog, selectedLabel);
  const ready = catalog.status === "ready";

  return (
    <button
      aria-busy={presentation.busy || undefined}
      aria-expanded={ready ? menuOpen : undefined}
      aria-haspopup={ready ? "menu" : undefined}
      aria-label={presentation.ariaLabel}
      aria-live="polite"
      className={className}
      disabled={disabled || presentation.disabled}
      onClick={ready ? onToggle : catalog.status === "error" ? onRetry : undefined}
      title={presentation.title}
      type="button"
    >
      {leadingIcon}
      {presentation.label}
      {ready && <ChevronDownIcon className={chevronClassName} />}
      {catalog.status === "loading" && <LoadingIndicator />}
      {catalog.status === "error" && (
        <RefreshCwIcon className={catalog.retrying ? "size-[14px] animate-spin" : "size-[14px]"} />
      )}
    </button>
  );
}

export function workbenchModelCatalogErrorLabel(error: unknown): string {
  if (isWorkbenchApiError(error) && error.status === 502) return "模型连接失败，重试";
  if (isWorkbenchApiError(error) && error.status === 504) return "模型响应超时，重试";
  return "模型加载失败，重试";
}

function modelCatalogButtonPresentation(
  catalog: WorkbenchModelCatalogState,
  selectedLabel?: string,
): {
  ariaLabel: string;
  busy: boolean;
  disabled: boolean;
  label: string;
  title: string;
} {
  switch (catalog.status) {
    case "loading":
      return {
        ariaLabel: "正在加载产品工作台模型目录",
        busy: true,
        disabled: true,
        label: "正在加载模型",
        title: "正在加载产品工作台模型目录",
      };
    case "empty":
      return {
        ariaLabel: "产品工作台暂无可用模型",
        busy: false,
        disabled: true,
        label: "无可用模型",
        title: "产品工作台暂无可用模型",
      };
    case "error": {
      const label = catalog.retrying
        ? "正在重试模型"
        : workbenchModelCatalogErrorLabel(catalog.error);
      return {
        ariaLabel: label,
        busy: catalog.retrying,
        disabled: catalog.retrying,
        label,
        title: label,
      };
    }
    case "ready": {
      const label = selectedLabel ?? "选择模型";
      return {
        ariaLabel: `模型：${label}`,
        busy: false,
        disabled: false,
        label,
        title: `当前模型：${label}`,
      };
    }
  }
}

function LoadingIndicator() {
  return (
    <span
      aria-hidden="true"
      className="size-[14px] animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}
