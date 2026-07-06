"use client";

import {
  ChevronRightIcon,
  FileTextIcon,
  PanelRightOpenIcon,
  SquareStackIcon,
} from "lucide-react";
import { useArtifact } from "@/hooks/use-artifact";
import { cn } from "@/lib/utils";
import type { ArtifactKind } from "./artifact";

type CanvasDocumentCardProps = {
  documentId: string;
  kind: ArtifactKind;
  title: string;
  status?: "streaming" | "idle";
  className?: string;
};

export function CanvasDocumentCard({
  documentId,
  kind,
  title,
  status = "idle",
  className,
}: CanvasDocumentCardProps) {
  const { artifact, setArtifact } = useArtifact();
  const isCurrentArtifact = artifact.documentId === documentId;
  const displayStatus = isCurrentArtifact ? artifact.status : status;
  const label = kind === "prototype" ? "原型" : "文档";
  const safeTitle = title?.trim() || (kind === "prototype" ? "原型" : "产品需求文档");
  const isStreaming = displayStatus === "streaming";
  const statusText = isStreaming ? `正在生成${label}` : `已生成${label}`;
  const isOpen = artifact.isVisible && isCurrentArtifact;

  return (
    <button
      aria-label={`打开${label}：${safeTitle}`}
      className={cn(
        "group/canvas-card relative flex w-full max-w-[min(100%,620px)] items-center gap-3 overflow-hidden rounded-lg border border-white/10 bg-[#171819]/90 px-3 py-3 text-left shadow-[var(--shadow-card)] backdrop-blur-xl transition-all hover:border-white/20 hover:bg-[#1d1f20] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        isOpen && "border-white/20 bg-[#202124]",
        className
      )}
      data-document-id={documentId}
      data-testid="canvas-document-card"
      onClick={() => {
        setArtifact((currentArtifact) => {
          const isSameDocument = currentArtifact.documentId === documentId;
          return {
            ...currentArtifact,
            documentId,
            kind,
            title: safeTitle,
            content: isSameDocument ? currentArtifact.content : "",
            status:
              isSameDocument && currentArtifact.status === "streaming"
                ? "streaming"
                : status,
            isVisible: true,
          };
        });
      }}
      type="button"
    >
      <span className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-[oklch(0.72_0.09_165)] opacity-0 transition-opacity group-hover/canvas-card:opacity-80" />

      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-primary ring-1 ring-white/10">
        {kind === "prototype" ? (
          <PanelRightOpenIcon className="size-4" />
        ) : (
          <FileTextIcon className="size-4" />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium leading-snug text-foreground">
            {safeTitle}
          </span>
          {isOpen ? (
            <span className="shrink-0 rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] text-muted-foreground">
              已打开
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5 truncate text-xs leading-snug text-muted-foreground">
          {isStreaming ? (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary/70" />
          ) : (
            <SquareStackIcon className="size-3 shrink-0 text-muted-foreground/60" />
          )}
          <span className="truncate">{statusText}</span>
        </span>
      </span>

      <span className="hidden h-8 shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-2.5 text-[12px] font-medium text-foreground/75 ring-1 ring-white/10 transition-colors group-hover/canvas-card:bg-white/[0.1] sm:flex">
        打开
        <ChevronRightIcon className="size-3.5 transition-transform group-hover/canvas-card:translate-x-0.5" />
      </span>
    </button>
  );
}
