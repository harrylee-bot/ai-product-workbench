"use client";

import { motion } from "framer-motion";
import {
  CheckCircle2Icon,
  CircleXIcon,
  FileUpIcon,
  FileSearchIcon,
  HashIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  UploadCloudIcon,
  XIcon,
} from "lucide-react";
import { useRef, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type {
  WorkbenchUploadItemViewModel,
  WorkbenchUploadStage,
} from "@/lib/workbench/files/upload-registry";

import { panelTransition } from "./workbench-motion";

export type WorkbenchSubmissionRecoveryViewModel = {
  actionPending: boolean;
  cancellable: boolean;
  error: string | null;
  files: readonly {
    byteSize: number;
    fileName: string;
    position: number;
  }[];
  kind: "failed" | "processing" | "waiting_files";
  message: string;
  retryable: boolean;
};

export function WorkbenchUploadList({
  uploads,
  placement,
  onCancel,
  onPause,
  onResume,
  onRetry,
  recovery = null,
  onCancelRecovery,
  onRetryRecovery,
  onSelectRecoveryFiles,
}: {
  uploads: readonly WorkbenchUploadItemViewModel[];
  placement: "home" | "project";
  onCancel: (id: string) => Promise<void>;
  onPause: (id: string) => boolean;
  onResume: (id: string) => boolean;
  onRetry: (id: string) => Promise<void>;
  recovery?: WorkbenchSubmissionRecoveryViewModel | null;
  onCancelRecovery?: () => Promise<unknown>;
  onRetryRecovery?: () => Promise<unknown>;
  onSelectRecoveryFiles?: (files: FileList) => Promise<unknown>;
}) {
  const recoveryFileInput = useRef<HTMLInputElement>(null);
  if (uploads.length === 0 && !recovery) return null;

  return (
    <motion.section
      animate={{ opacity: 1, y: 0 }}
      aria-label="文件处理进度"
      className={cn(
        "fixed z-[65] w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[8px] border border-white/[0.12] bg-[#18191b]/96 text-[#e8eaed] shadow-[0_22px_80px_-36px_rgba(0,0,0,0.98)] backdrop-blur-2xl",
        placement === "home"
          ? "right-[24px] top-[76px] max-sm:left-[16px] max-sm:right-auto"
          : "bottom-[104px] left-1/2 -translate-x-1/2 md:max-w-[calc(100vw-640px)]",
      )}
      data-workbench-upload-list
      initial={{ opacity: 0, y: 6 }}
      transition={panelTransition}
    >
      <div className="flex h-[34px] items-center border-b border-white/[0.08] px-[12px]">
        <span className="text-[13px] font-semibold text-[#f1f3f4]">文件处理</span>
        <span className="ml-auto text-[12px] tabular-nums text-[#9da2aa]">
          {uploads.length + (recovery?.files.length ?? 0)}
        </span>
      </div>
      <div className="max-h-[244px] overflow-y-auto">
        {recovery && (
          <SubmissionRecoveryRow
            inputRef={recoveryFileInput}
            onCancel={onCancelRecovery}
            onRetry={onRetryRecovery}
            onSelectFiles={onSelectRecoveryFiles}
            recovery={recovery}
          />
        )}
        {uploads.map((upload) => (
          <UploadRow
            key={upload.id}
            onCancel={onCancel}
            onPause={onPause}
            onResume={onResume}
            onRetry={onRetry}
            upload={upload}
          />
        ))}
      </div>
    </motion.section>
  );
}

function SubmissionRecoveryRow({
  inputRef,
  onCancel,
  onRetry,
  onSelectFiles,
  recovery,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onCancel?: () => Promise<unknown>;
  onRetry?: () => Promise<unknown>;
  onSelectFiles?: (files: FileList) => Promise<unknown>;
  recovery: WorkbenchSubmissionRecoveryViewModel;
}) {
  const StatusIcon = recovery.kind === "processing"
    ? LoaderCircleIcon
    : recovery.kind === "failed"
      ? CircleXIcon
      : FileUpIcon;
  return (
    <div
      className="grid min-h-[74px] grid-cols-[20px_minmax(0,1fr)_auto] gap-x-[9px] border-b border-white/[0.06] px-[12px] py-[10px]"
      data-workbench-submission-recovery={recovery.kind}
    >
      <StatusIcon
        aria-hidden="true"
        className={cn(
          "mt-[1px] size-[17px]",
          recovery.kind === "processing" && "animate-spin text-[#cdd1d7]",
          recovery.kind === "failed" && "text-[#ef8c8c]",
          recovery.kind === "waiting_files" && "text-[#cdd1d7]",
        )}
      />
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[#eef0f3]">恢复未完成的提交</div>
        <div
          className={cn(
            "mt-[3px] text-[12px] leading-[14px] text-[#9fa4ac]",
            recovery.files.length === 0 && "truncate",
          )}
          title={recovery.error ?? recovery.message}
        >
          {recovery.error ?? recovery.message}
        </div>
        {recovery.files.length > 0 && (
          <div className="mt-[6px] space-y-[2px]">
            {recovery.files.map((file) => (
              <div
                className="flex min-w-0 items-center gap-[6px] text-[12px] text-[#b9bec6]"
                key={file.position}
              >
                <span className="min-w-0 flex-1 truncate" title={file.fileName}>{file.fileName}</span>
                <span className="shrink-0 tabular-nums text-[#858a92]">{formatByteSize(file.byteSize)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex h-[28px] min-w-[28px] items-center justify-end gap-[2px]">
        {recovery.actionPending && (
          <LoaderCircleIcon aria-label="正在处理" className="size-[15px] animate-spin text-[#b9bec6]" />
        )}
        {(!recovery.actionPending || recovery.cancellable) && (
          <>
            {!recovery.actionPending && recovery.kind === "waiting_files" && onSelectFiles && (
              <>
                <input
                  className="hidden"
                  multiple
                  onChange={(event) => {
                    const files = event.target.files;
                    event.target.value = "";
                    if (!files?.length) return;
                    void onSelectFiles(files).catch((error) => {
                      toast.error(uploadActionError(error, "附件恢复失败，请重试"));
                    });
                  }}
                  ref={inputRef}
                  type="file"
                />
                <UploadActionButton
                  label="重新选择待上传附件"
                  onClick={() => inputRef.current?.click()}
                >
                  <FileUpIcon className="size-[14px]" />
                </UploadActionButton>
              </>
            )}
            {!recovery.actionPending && recovery.kind === "failed" && recovery.retryable && onRetry && (
              <UploadActionButton
                label="重试提交"
                onClick={() => {
                  void onRetry().catch((error) => {
                    toast.error(uploadActionError(error, "重试提交失败"));
                  });
                }}
              >
                <RotateCcwIcon className="size-[14px]" />
              </UploadActionButton>
            )}
            {recovery.cancellable && onCancel && (
              <UploadActionButton
                label="取消未完成的提交"
                onClick={() => {
                  void onCancel().catch((error) => {
                    toast.error(uploadActionError(error, "取消提交失败"));
                  });
                }}
              >
                <XIcon className="size-[15px]" />
              </UploadActionButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatByteSize(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 ** 2) return `${Math.ceil(byteSize / 1024)} KB`;
  return `${(byteSize / 1024 ** 2).toFixed(1)} MB`;
}

function UploadRow({
  upload,
  onCancel,
  onPause,
  onResume,
  onRetry,
}: {
  upload: WorkbenchUploadItemViewModel;
  onCancel: (id: string) => Promise<void>;
  onPause: (id: string) => boolean;
  onResume: (id: string) => boolean;
  onRetry: (id: string) => Promise<void>;
}) {
  const StatusIcon = statusIcon(upload.stage);
  const retryLabel = upload.error?.code === "UPLOAD_CANCEL_FAILED" ? "重试取消" : "重试上传";

  return (
    <div className="grid min-h-[74px] grid-cols-[20px_minmax(0,1fr)_auto] gap-x-[9px] border-b border-white/[0.06] px-[12px] py-[10px] last:border-b-0">
      <StatusIcon
        aria-hidden="true"
        className={cn(
          "mt-[1px] size-[17px]",
          upload.stage === "ready" && "text-[#70c98d]",
          upload.stage === "failed" && "text-[#ef8c8c]",
          upload.stage === "cancelled" && "text-[#8f949c]",
          !["ready", "failed", "cancelled"].includes(upload.stage) && "text-[#cdd1d7]",
        )}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-[8px]">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#eef0f3]" title={upload.fileName}>
            {upload.fileName}
          </span>
          <span className="shrink-0 text-[12px] tabular-nums text-[#a9aeb6]">{upload.progress}%</span>
        </div>
        <div className="mt-[3px] truncate text-[12px] leading-[14px] text-[#9fa4ac]" title={upload.error?.message}>
          {upload.error?.message ?? upload.statusLabel}
        </div>
        <div
          aria-label={`${upload.fileName} 处理进度`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={upload.progress}
          className="mt-[7px] h-[3px] overflow-hidden rounded-full bg-white/[0.08]"
          role="progressbar"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-200",
              upload.stage === "failed" ? "bg-[#d96f6f]" : "bg-[#d9dde3]",
              upload.stage === "cancelled" && "bg-[#747981]",
            )}
            style={{ width: `${upload.progress}%` }}
          />
        </div>
      </div>
      <div className="flex h-[28px] min-w-[28px] items-center justify-end gap-[2px]">
        {upload.actionPending ? (
          <LoaderCircleIcon aria-label="正在处理" className="size-[15px] animate-spin text-[#b9bec6]" />
        ) : (
          <>
            {upload.canPause && (
              <UploadActionButton
                label={`暂停上传 ${upload.fileName}`}
                onClick={() => onPause(upload.id)}
              >
                <PauseIcon className="size-[14px]" />
              </UploadActionButton>
            )}
            {upload.canResume && (
              <UploadActionButton
                label={`继续上传 ${upload.fileName}`}
                onClick={() => onResume(upload.id)}
              >
                <PlayIcon className="size-[14px]" />
              </UploadActionButton>
            )}
            {upload.canRetry && (
              <UploadActionButton
                label={`${retryLabel} ${upload.fileName}`}
                onClick={() => {
                  void onRetry(upload.id).catch((error) => {
                    toast.error(uploadActionError(error, "重试失败，请稍后再试"));
                  });
                }}
              >
                <RotateCcwIcon className="size-[14px]" />
              </UploadActionButton>
            )}
            {upload.canCancel && (
              <UploadActionButton
                label={`取消上传 ${upload.fileName}`}
                onClick={() => {
                  void onCancel(upload.id).catch((error) => {
                    toast.error(uploadActionError(error, "取消失败，请稍后再试"));
                  });
                }}
              >
                <XIcon className="size-[15px]" />
              </UploadActionButton>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function UploadActionButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick: () => unknown;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className="grid size-[28px] place-items-center rounded-full text-[#c5c9d0] hover:bg-white/[0.08] hover:text-[#f1f3f4]"
          onClick={onClick}
          type="button"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function statusIcon(stage: WorkbenchUploadStage) {
  if (stage === "hash") return HashIcon;
  if (stage === "upload") return UploadCloudIcon;
  if (stage === "verify") return ShieldCheckIcon;
  if (stage === "extract") return FileSearchIcon;
  if (stage === "ready") return CheckCircle2Icon;
  return CircleXIcon;
}

function uploadActionError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
