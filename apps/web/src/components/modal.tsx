"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui";

export function Modal({
  open,
  title,
  children,
  footer,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] px-4 py-8">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-[520px] rounded-[var(--radius-panel)] border border-[var(--color-border)] bg-white shadow-[var(--shadow-float)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
          <h2 className="text-base font-semibold text-gray-950">{title}</h2>
          <IconButton label="关闭" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="px-5 py-5">{children}</div>
        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-5 py-4">{footer}</div>
      </div>
    </div>
  );
}
