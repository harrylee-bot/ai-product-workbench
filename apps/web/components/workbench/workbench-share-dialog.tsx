"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2Icon, CopyIcon, XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { writeWorkbenchClipboard } from "@/lib/workbench/browser/clipboard";
import { drawerTransition, workbenchEase } from "./workbench-motion";

export function WorkbenchShareDialog({
  busy,
  error,
  onEnsureLink,
  onOpenChange,
  onRetryState,
  onToggle,
  open,
  shareEnabled,
  stateError,
  statePending,
  shareUrl,
}: {
  busy: boolean;
  error: unknown;
  onEnsureLink: () => Promise<string>;
  onOpenChange: (open: boolean) => void;
  onRetryState: () => Promise<unknown>;
  onToggle: () => Promise<string | null>;
  open: boolean;
  shareEnabled: boolean;
  stateError: unknown;
  statePending: boolean;
  shareUrl: string | null;
}) {
  const [linkCopied, setLinkCopied] = useState(false);
  const returnFocusTargetRef = useRef<HTMLElement | null>(null);
  const stateUnavailable = statePending || Boolean(stateError);
  const interactionDisabled = busy || stateUnavailable;

  useEffect(() => {
    if (!open) setLinkCopied(false);
  }, [open]);

  const copyShareLink = useCallback(async () => {
    const url = await onEnsureLink();
    await writeWorkbenchClipboard(url);
    setLinkCopied(true);
  }, [onEnsureLink]);

  const copyShareLinkWithFeedback = () => {
    void copyShareLink().catch(() => {
      toast.error("复制链接失败，请检查浏览器剪贴板权限");
    });
  };

  return (
    <Dialog.Root modal onOpenChange={onOpenChange} open={open}>
      <AnimatePresence>
        {open && (
          <>
          <Dialog.Overlay asChild forceMount>
            <motion.div
              animate={{ opacity: 1 }}
              className="workbench-dialog-backdrop fixed inset-0 z-40 bg-black/48"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              onClick={() => onOpenChange(false)}
              transition={{ duration: 0.18, ease: workbenchEase }}
            />
          </Dialog.Overlay>
          <Dialog.Content
            aria-describedby={undefined}
            asChild
            forceMount
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const returnFocusTarget = returnFocusTargetRef.current;
              if (returnFocusTarget?.isConnected) returnFocusTarget.focus();
              returnFocusTargetRef.current = null;
            }}
            onOpenAutoFocus={() => {
              const activeElement = document.activeElement;
              returnFocusTargetRef.current = activeElement instanceof HTMLElement
                && activeElement !== document.body
                ? activeElement
                : null;
            }}
            onEscapeKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
            }}
            onPointerDownOutside={(event) => event.preventDefault()}
          >
            <motion.aside
              animate={{ opacity: 1, scale: 1, x: 0 }}
              aria-modal="true"
              className="workbench-dialog-panel fixed right-[16px] top-[80px] z-50 flex h-[560px] max-h-[calc(100vh-104px)] w-[320px] max-w-[calc(100vw-32px)] origin-top-right flex-col overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#18191b]/92 text-[#e8eaed] shadow-[0_24px_90px_-42px_rgba(0,0,0,0.95)] backdrop-blur-2xl sm:right-[clamp(24px,2vw,32px)] max-md:inset-0 max-md:h-full max-md:max-h-none max-md:w-full max-md:max-w-none max-md:rounded-none"
              data-workbench-global-panel
              exit={{ opacity: 0, scale: 0.992, x: 24 }}
              initial={{ opacity: 0, scale: 0.992, x: 24 }}
              transition={drawerTransition}
            >
          <div className="flex h-[58px] shrink-0 items-center justify-between px-[20px]">
            <Dialog.Title asChild>
              <h2 className="text-[20px] font-semibold">共享</h2>
            </Dialog.Title>
            <button
              aria-label="关闭共享"
              className="grid size-[28px] place-items-center rounded-full text-[#c7cad0] hover:bg-white/[0.06]"
              onClick={() => onOpenChange(false)}
              type="button"
            >
              <XIcon className="size-[17px]" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-[20px] pb-[18px] pt-[10px]">
            <div className="mb-[20px] rounded-[16px] border border-white/[0.08] bg-[#202124]/76 p-[14px]">
              <div className="mb-[12px] flex items-center justify-between gap-[14px]">
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold text-[#f1f3f4]">启用共享和重混功能</div>
                  <div className="mt-[6px] text-[13px] leading-[17px] text-[#aeb3bb]">
                    {statePending
                      ? "正在读取共享状态..."
                      : stateError
                        ? (
                            <button
                              className="font-semibold text-[#d8c8ff] hover:text-white"
                              onClick={() => void onRetryState().catch(() => undefined)}
                              type="button"
                            >
                              共享状态加载失败，重试
                            </button>
                          )
                        : busy
                      ? "正在发布当前项目版本..."
                      : error
                        ? "共享操作失败，请重试"
                        : shareEnabled
                          ? "知道链接的任何人都可以访问此项目"
                          : "只有您本人可以访问此项目"}
                  </div>
                </div>
                <button
                  aria-checked={shareEnabled}
                  aria-disabled={interactionDisabled}
                  aria-label="启用共享和重混功能"
                  className={cn(
                    "relative h-[32px] w-[58px] shrink-0 rounded-full p-[4px] transition-colors",
                    shareEnabled ? "bg-[#c9c2ff]" : "bg-[#50545a]",
                  )}
                  disabled={interactionDisabled}
                  onClick={() => {
                    setLinkCopied(false);
                    void onToggle().catch(() => undefined);
                  }}
                  role="switch"
                  type="button"
                >
                  <span
                    className={cn(
                      "block size-[24px] rounded-full bg-[#f1f3f4] transition-transform duration-200",
                      shareEnabled && "translate-x-[26px] bg-[#281d36]",
                    )}
                  />
                </button>
              </div>
              <div className="whitespace-normal rounded-[10px] border border-white/[0.08] bg-[#191a1d]/76 p-[12px] text-[13px] leading-[18px] text-[#cbc3d7]">
                将项目设为公开后，知道链接的任何人都可以查看和重混该项目生成的设计和代码。您可以随时撤销公开访问权限。
              </div>
            </div>
            <div className="rounded-[16px] border border-white/[0.08] bg-[#111214]/58 p-[14px]">
              <div className="mb-[10px] text-[13px] font-semibold text-[#f1f3f4]">链接访问权限</div>
              <button
                className="flex h-[38px] w-full items-center justify-between rounded-[10px] bg-[#242528]/84 px-[12px] text-[13px] text-[#c7cad0] hover:bg-[#2b2d31]/90"
                disabled={!shareEnabled || interactionDisabled}
                onClick={copyShareLinkWithFeedback}
                type="button"
              >
                <span className="truncate">{linkCopied ? "链接已复制" : shareUrl ?? "生成可复制的公开链接"}</span>
                {linkCopied ? <CheckCircle2Icon className="size-[14px] shrink-0" /> : <CopyIcon className="size-[14px] shrink-0" />}
              </button>
            </div>
          </div>
          <div className="border-t border-white/[0.06] p-[14px]">
            <button
              className={cn(
                "h-[36px] w-full rounded-[11px] border border-white/[0.08] text-[14px] font-semibold transition-colors",
                shareEnabled ? "bg-[#c9c2ff] text-[#21172d]" : "bg-[#2a2a2b]/70 text-[#958ea0]",
              )}
              disabled={!shareEnabled || interactionDisabled}
              onClick={copyShareLinkWithFeedback}
              type="button"
            >
              {linkCopied ? "已复制链接" : "复制链接"}
            </button>
          </div>
            </motion.aside>
          </Dialog.Content>
          </>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
