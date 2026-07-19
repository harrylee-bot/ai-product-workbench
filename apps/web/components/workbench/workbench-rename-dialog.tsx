"use client";

import { motion } from "framer-motion";
import { XIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useId, useRef, useState } from "react";
import { drawerTransition, workbenchEase } from "./workbench-motion";

export function RenameProjectDialog({
  currentTitle,
  dialogLabel = "重命名项目",
  failureMessage = "重命名失败，请重试",
  heading = "重命名项目",
  onClose,
  onRename,
}: {
  currentTitle: string;
  dialogLabel?: string;
  failureMessage?: string;
  heading?: string;
  onClose: () => void;
  onRename: (title: string) => Promise<unknown>;
}) {
  const [title, setTitle] = useState(currentTitle);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputId = useId();
  const errorId = useId();
  const returnFocusTargetRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <Dialog.Root
      modal
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open
    >
      <Dialog.Portal>
        <Dialog.Overlay asChild>
          <motion.div
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-[125] bg-black/48"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: workbenchEase }}
          />
        </Dialog.Overlay>
        <Dialog.Content
          aria-describedby={failed ? errorId : undefined}
          aria-label={dialogLabel}
          aria-modal="true"
          asChild
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocusTargetRef.current;
            returnFocusTargetRef.current = null;
            if (target?.isConnected) target.focus();
          }}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
          onOpenAutoFocus={(event) => {
            if (!returnFocusTargetRef.current) {
              const activeElement = document.activeElement;
              returnFocusTargetRef.current = activeElement instanceof HTMLElement
                && activeElement !== document.body
                ? activeElement
                : null;
            }
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <motion.form
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="fixed left-1/2 top-1/2 z-[130] w-[360px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border border-white/[0.10] bg-[#18191b]/96 p-[18px] text-[#e8eaed] shadow-[0_28px_100px_-42px_rgba(0,0,0,0.98)] backdrop-blur-2xl max-md:left-0 max-md:top-0 max-md:h-full max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:p-[16px]"
            exit={{ opacity: 0, scale: 0.985, y: 5 }}
            initial={{ opacity: 0, scale: 0.985, y: 5 }}
            onSubmit={(event) => {
              event.preventDefault();
              const normalized = title.trim();
              if (!normalized || busy) return;
              setBusy(true);
              setFailed(false);
              void onRename(normalized)
                .then(() => {
                  setBusy(false);
                  onClose();
                })
                .catch(() => {
                  setBusy(false);
                  setFailed(true);
                });
            }}
            transition={drawerTransition}
          >
        <div className="mb-[16px] flex items-center justify-between">
          <Dialog.Title asChild>
            <h2 className="text-[17px] font-semibold text-[#f1f3f4]">{heading}</h2>
          </Dialog.Title>
          <button
            aria-label="关闭"
            className="grid size-[28px] place-items-center rounded-full text-[#c7cad0] hover:bg-white/[0.06]"
            onClick={close}
            type="button"
          >
            <XIcon aria-hidden="true" className="size-[17px]" />
          </button>
        </div>
        <label className="sr-only" htmlFor={inputId}>新标题</label>
        <input
          autoFocus
          className="h-[42px] w-full rounded-[10px] border border-white/[0.12] bg-[#222326] px-[12px] text-[14px] text-[#f1f3f4] outline-none transition-colors focus:border-[#bfa7ff]/70"
          id={inputId}
          maxLength={160}
          onChange={(event) => {
            setTitle(event.target.value);
            setFailed(false);
          }}
          ref={inputRef}
          value={title}
        />
        <div
          className="mt-[8px] min-h-[17px] text-[11px] text-[#f2a7a7]"
          id={errorId}
          role={failed ? "alert" : undefined}
        >
          {failed ? failureMessage : null}
        </div>
        <div className="mt-[12px] flex justify-end gap-[8px]">
          <button
            className="h-[34px] rounded-[10px] border border-white/[0.10] px-[14px] text-[13px] font-semibold text-[#d8dce2] hover:bg-white/[0.06]"
            onClick={close}
            type="button"
          >
            取消
          </button>
          <button
            className="h-[34px] rounded-[10px] bg-[#c9b3ff] px-[16px] text-[13px] font-semibold text-[#241832] disabled:opacity-50"
            disabled={busy || !title.trim() || title.trim() === currentTitle}
            type="submit"
          >
            {busy ? "保存中..." : "保存"}
          </button>
        </div>
          </motion.form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
