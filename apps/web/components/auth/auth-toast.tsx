"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast as sonnerToast, Toaster } from "sonner";

import { cn } from "@/lib/utils";

import { CheckCircleFillIcon, WarningIcon } from "./auth-icons";

const iconsByType: Record<"success" | "error", ReactNode> = {
  success: <CheckCircleFillIcon />,
  error: <WarningIcon />,
};

export function authToast(props: Omit<AuthToastProps, "id">) {
  return sonnerToast.custom((id) => (
    <AuthToast description={props.description} id={id} type={props.type} />
  ));
}

export function AuthToaster() {
  return (
    <Toaster
      position="top-center"
      theme="dark"
      toastOptions={{
        className:
          "!bg-card !text-foreground !border-border/70 !shadow-[var(--shadow-float)] !backdrop-blur-xl",
      }}
    />
  );
}

function AuthToast(props: AuthToastProps) {
  const { id, type, description } = props;

  const descriptionRef = useRef<HTMLDivElement>(null);
  const [multiLine, setMultiLine] = useState(false);

  useEffect(() => {
    const el = descriptionRef.current;
    if (!el) {
      return;
    }

    const update = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
      const lines = Math.round(el.scrollHeight / lineHeight);
      setMultiLine(lines > 1);
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);

    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex toast-mobile:w-[356px] w-full justify-center">
      <div
        className={cn(
          "flex toast-mobile:w-fit w-full flex-row gap-3 rounded-lg bg-card border border-border/50 shadow-[var(--shadow-float)] p-3",
          multiLine ? "items-start" : "items-center"
        )}
        data-testid="toast"
        key={id}
      >
        <div
          className={cn(
            "data-[type=error]:text-red-600 data-[type=success]:text-green-600",
            { "pt-1": multiLine }
          )}
          data-type={type}
        >
          {iconsByType[type]}
        </div>
        <div className="text-sm text-foreground" ref={descriptionRef}>
          {description}
        </div>
      </div>
    </div>
  );
}

type AuthToastProps = {
  id: string | number;
  type: "success" | "error";
  description: string;
};
