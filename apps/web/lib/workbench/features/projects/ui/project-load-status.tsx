"use client";

import { isWorkbenchApiError } from "../../../api";

export function ProjectLoadStatus({
  error,
  onRetry,
  status,
}: {
  error: unknown;
  onRetry: () => void;
  status: "error" | "loading" | "ready";
}) {
  if (status === "ready") return null;
  return (
    <div className="absolute inset-0 z-[35] grid place-items-center bg-[var(--workbench-bg)]/88 text-center backdrop-blur-sm">
      <div className="max-w-[360px] px-[24px] text-[13px] font-medium text-[#aeb3bb]">
        <p className="whitespace-normal">
          {status === "loading" ? "正在加载项目..." : projectLoadErrorMessage(error)}
        </p>
        {status === "error" && (
          <button
            className="mt-[12px] rounded-full border border-white/[0.10] px-[14px] py-[7px] text-[#d8dce2] hover:bg-white/[0.06]"
            onClick={onRetry}
            type="button"
          >
            重试
          </button>
        )}
      </div>
    </div>
  );
}

function projectLoadErrorMessage(error: unknown): string {
  if (isWorkbenchApiError(error) && error.status === 404) {
    return "项目不存在，或您已没有访问权限。";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return "项目加载失败，请重试。";
}
