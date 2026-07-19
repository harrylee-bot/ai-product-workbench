"use client";

import type {
  ApprovalDecision,
  JsonValue,
  RunApproval,
} from "@workbench/workbench-contracts";
import { ShieldCheckIcon } from "lucide-react";
import { motion } from "framer-motion";
import { Dialog, RadioGroup } from "radix-ui";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const workbenchEase = [0.16, 1, 0.3, 1] as const;
const drawerTransition = { duration: 0.30, ease: workbenchEase } as const;

export function WorkbenchRunApprovalDialog({
  approval,
  busy,
  error,
  onSubmit,
}: {
  approval: RunApproval;
  busy: boolean;
  error: unknown;
  onSubmit: (decision: ApprovalDecision, value?: JsonValue) => Promise<unknown>;
}) {
  const [selectedOptionId, setSelectedOptionId] = useState(approval.options[0]?.id ?? "");
  const focusLifetime = useRef<symbol | null>(null);
  const returnFocusTarget = useRef<HTMLElement | null>(null);
  if (returnFocusTarget.current === null
    && typeof document !== "undefined"
    && document.activeElement instanceof HTMLElement
    && document.activeElement !== document.body) {
    returnFocusTarget.current = document.activeElement;
  }
  const selectedOption = approval.options.find((option) => option.id === selectedOptionId)
    ?? approval.options[0];

  useEffect(() => {
    setSelectedOptionId(approval.options[0]?.id ?? "");
  }, [approval.id, approval.options]);

  useEffect(() => {
    const token = Symbol("workbench-approval-focus-lifetime");
    focusLifetime.current = token;
    return () => {
      queueMicrotask(() => {
        if (focusLifetime.current !== token) return;
        const target = returnFocusTarget.current;
        if (target?.isConnected) target.focus();
      });
    };
  }, []);

  const submit = (decision: ApprovalDecision) => {
    const operation = decision === "submit" && selectedOption
      ? onSubmit("submit", selectedOption.value)
      : onSubmit(decision);
    void operation.catch(() => undefined);
  };

  return (
    <Dialog.Root modal open>
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
          asChild
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <motion.aside
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="fixed left-1/2 top-1/2 z-[130] w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border border-white/[0.10] bg-[#18191b]/96 p-[18px] text-[#e8eaed] shadow-[0_28px_100px_-42px_rgba(0,0,0,0.98)] backdrop-blur-2xl max-md:left-0 max-md:top-0 max-md:h-full max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:p-[16px]"
            exit={{ opacity: 0, scale: 0.985, y: 5 }}
            initial={{ opacity: 0, scale: 0.985, y: 5 }}
            transition={drawerTransition}
          >
        <div className="mb-[14px] flex items-center gap-[10px]">
          <span className="grid size-[32px] shrink-0 place-items-center rounded-[9px] bg-[#3a2d4b] text-[#d8c8ff]">
            <ShieldCheckIcon className="size-[16px]" />
          </span>
          <div>
            <Dialog.Title asChild>
              <h2 className="text-[16px] font-semibold text-[#f1f3f4]">需要您的确认</h2>
            </Dialog.Title>
            <Dialog.Description asChild>
              <p className="mt-[2px] text-[11px] text-[#9aa0a6]">运行将在提交后继续</p>
            </Dialog.Description>
          </div>
        </div>
        <p className="whitespace-normal text-[13px] leading-[20px] text-[#d8dce2]">
          {approval.prompt}
        </p>
        {approval.options.length > 0 && (
          <RadioGroup.Root
            aria-label={approval.prompt}
            className="mt-[14px] space-y-[7px]"
            disabled={busy}
            onValueChange={setSelectedOptionId}
            value={selectedOptionId}
          >
            {approval.options.map((option) => {
              const selected = option.id === selectedOption?.id;
              return (
                <RadioGroup.Item
                  className={cn(
                    "w-full rounded-[10px] border px-[12px] py-[9px] text-left transition-colors",
                    selected
                      ? "border-[#bfa7ff]/70 bg-[#3a2d4b]/82"
                      : "border-white/[0.08] bg-[#242528]/82 hover:bg-[#2b2d31]/90",
                  )}
                  key={option.id}
                  value={option.id}
                >
                  <span className="block text-[13px] font-semibold text-[#f1f3f4]">{option.label}</span>
                  {option.description && (
                    <span className="mt-[3px] block whitespace-normal text-[11px] leading-[16px] text-[#aeb3bb]">
                      {option.description}
                    </span>
                  )}
                </RadioGroup.Item>
              );
            })}
          </RadioGroup.Root>
        )}
        <div className="mt-[8px] min-h-[17px] text-[11px] text-[#f2a7a7]">
          {error ? "提交失败，请重试" : null}
        </div>
        <div className="mt-[12px] flex justify-end gap-[8px]">
          <button
            className="h-[34px] rounded-[10px] border border-white/[0.10] px-[14px] text-[13px] font-semibold text-[#f2a7a7] hover:bg-white/[0.06] disabled:opacity-50"
            disabled={busy}
            onClick={() => submit("reject")}
            type="button"
          >
            拒绝
          </button>
          <button
            className="h-[34px] rounded-[10px] bg-[#c9b3ff] px-[16px] text-[13px] font-semibold text-[#241832] disabled:opacity-50"
            disabled={busy || (approval.options.length > 0 && !selectedOption)}
            onClick={() => submit(approval.options.length > 0 ? "submit" : "approve")}
            type="button"
          >
            {busy ? "提交中..." : approval.options.length > 0 ? "确认选择" : "批准"}
          </button>
        </div>
          </motion.aside>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
