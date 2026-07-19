"use client";

import { DownloadIcon, RefreshCcwIcon, UploadCloudIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type WorkbenchBoardConflictAction = "discard" | "replay" | null;

export function WorkbenchBoardConflictDialog({
  action,
  error,
  onDiscard,
  onExport,
  onOpenChange,
  onReplay,
  open,
}: {
  action: WorkbenchBoardConflictAction;
  error: string | null;
  onDiscard: () => Promise<unknown>;
  onExport: () => void;
  onOpenChange: (open: boolean) => void;
  onReplay: () => Promise<unknown>;
  open: boolean;
}) {
  const busy = action !== null;
  return (
    <Dialog onOpenChange={(nextOpen) => !busy && onOpenChange(nextOpen)} open={open}>
      <DialogContent className="w-[520px] max-w-[calc(100vw-32px)] border-white/[0.10] bg-[#18191b]/98 text-[#f1f3f4]">
        <DialogHeader>
          <DialogTitle>画布存在版本冲突</DialogTitle>
          <DialogDescription>
            服务器画布已更新，本地修改尚未保存。先导出本地副本，或明确选择保留哪一版。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="rounded-[6px] border border-[#ef8c8c]/25 bg-[#ef8c8c]/10 px-[10px] py-[8px] text-[12px] leading-[18px] text-[#f2a7a7]">
            {error}
          </p>
        )}
        <DialogFooter className="flex-wrap gap-[8px] sm:justify-between">
          <button
            className="flex h-[36px] items-center justify-center gap-[7px] rounded-[6px] border border-white/[0.10] px-[12px] text-[12px] text-[#d9dde3] transition-colors hover:bg-white/[0.06] disabled:opacity-45"
            disabled={busy}
            onClick={onExport}
            type="button"
          >
            <DownloadIcon className="size-[14px]" />
            导出本地副本
          </button>
          <div className="flex flex-wrap justify-end gap-[8px]">
            <button
              className="flex h-[36px] items-center justify-center gap-[7px] rounded-[6px] border border-white/[0.10] px-[12px] text-[12px] text-[#d9dde3] transition-colors hover:bg-white/[0.06] disabled:opacity-45"
              disabled={busy}
              onClick={() => void onDiscard()}
              type="button"
            >
              <RefreshCcwIcon className="size-[14px]" />
              {action === "discard" ? "正在读取..." : "使用服务器版本"}
            </button>
            <button
              className="flex h-[36px] items-center justify-center gap-[7px] rounded-[6px] bg-[#e8eaed] px-[12px] text-[12px] font-semibold text-[#202124] transition-colors hover:bg-white disabled:opacity-45"
              disabled={busy}
              onClick={() => void onReplay()}
              type="button"
            >
              <UploadCloudIcon className="size-[14px]" />
              {action === "replay" ? "正在保存..." : "使用本地版本"}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
