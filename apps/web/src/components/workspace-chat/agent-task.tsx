"use client";

import clsx from "clsx";
import { ChevronDown, Circle, SquareTerminal } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

// Adapted from Vercel AI Elements' Task registry component:
// https://elements.ai-sdk.dev/api/registry/task.json

type AgentTaskStatus = "info" | "running" | "done" | "failed" | "warning";

export type AgentTaskProps = ComponentProps<"details"> & {
  title: ReactNode;
  status?: AgentTaskStatus;
};

export function AgentTask({
  title,
  status = "info",
  className,
  children,
  open = true,
  ...props
}: AgentTaskProps) {
  return (
    <details
      open={open}
      className={clsx("group/task not-prose text-sm text-gray-400", className)}
      {...props}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 leading-6 transition hover:text-gray-600 [&::-webkit-details-marker]:hidden">
        <StatusIcon status={status} />
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform group-open/task:rotate-180" aria-hidden="true" />
      </summary>
      {children}
    </details>
  );
}

export type AgentTaskContentProps = ComponentProps<"div">;

export function AgentTaskContent({
  className,
  children,
  ...props
}: AgentTaskContentProps) {
  return (
    <div className={clsx("mt-1 space-y-1 border-l border-gray-200 pl-5", className)} {...props}>
      {children}
    </div>
  );
}

export type AgentTaskItemProps = ComponentProps<"div"> & {
  status?: AgentTaskStatus;
};

export function AgentTaskItem({
  status = "info",
  className,
  children,
  ...props
}: AgentTaskItemProps) {
  return (
    <div className={clsx("flex min-w-0 items-center gap-2 leading-6 text-gray-400", className)} {...props}>
      <StatusIcon status={status} subtle />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

export type AgentTaskBadgeProps = ComponentProps<"span">;

export function AgentTaskBadge({
  className,
  children,
  ...props
}: AgentTaskBadgeProps) {
  return (
    <span
      className={clsx(
        "mx-0.5 inline-flex max-w-full items-center rounded-md bg-gray-100 px-1.5 py-0.5 align-baseline font-mono text-[0.92em] leading-none text-gray-600",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

function StatusIcon({
  status,
  subtle,
}: {
  status: AgentTaskStatus;
  subtle?: boolean;
}) {
  if (status === "running") {
    return <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-gray-400 motion-safe:animate-pulse" aria-hidden="true" />;
  }

  const color =
    status === "failed"
      ? "text-red-400"
      : status === "warning"
        ? "text-amber-400"
        : status === "done"
          ? "text-emerald-400"
          : "text-gray-300";

  return (
    <Circle
      className={clsx("h-3 w-3 shrink-0 fill-current", color, subtle ? "opacity-50" : "opacity-70")}
      aria-hidden="true"
    />
  );
}
