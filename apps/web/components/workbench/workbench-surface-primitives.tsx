"use client";

import { useEffect, type RefObject } from "react";

export function useWorkbenchPointerVars<T extends HTMLElement>(ref: RefObject<T | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let frame = 0;
    const updatePointer = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      element.dataset.workbenchPointerActive = "true";

      cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        element.style.setProperty("--workbench-pointer-x", `${Math.max(0, Math.min(100, x)).toFixed(2)}%`);
        element.style.setProperty("--workbench-pointer-y", `${Math.max(0, Math.min(100, y)).toFixed(2)}%`);
        element.style.setProperty("--workbench-pointer-shift-x", `${((x - 50) * 0.035).toFixed(2)}px`);
        element.style.setProperty("--workbench-pointer-shift-y", `${((y - 50) * 0.035).toFixed(2)}px`);
      });
    };

    const settlePointer = () => {
      delete element.dataset.workbenchPointerActive;
      cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        element.style.setProperty("--workbench-pointer-x", "50%");
        element.style.setProperty("--workbench-pointer-y", "44%");
        element.style.setProperty("--workbench-pointer-shift-x", "0px");
        element.style.setProperty("--workbench-pointer-shift-y", "0px");
      });
    };

    element.addEventListener("pointermove", updatePointer);
    element.addEventListener("pointerleave", settlePointer);
    settlePointer();

    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("pointermove", updatePointer);
      element.removeEventListener("pointerleave", settlePointer);
    };
  }, [ref]);
}

export function DottedBackdrop({ interactive = false }: { interactive?: boolean }) {
  return (
    <>
      <div className="workbench-backdrop absolute inset-0" />
      {interactive && <div className="workbench-home-pointer-backdrop absolute inset-0" />}
    </>
  );
}
