"use client";

import { ChevronRightIcon, FileTextIcon, PanelRightOpenIcon } from "lucide-react";
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
  const label = kind === "prototype" ? "原型画布" : "需求文档画布";
  const safeTitle = title?.trim() || (kind === "prototype" ? "原型" : "产品需求文档");

  return (
    <button
      aria-label={`打开${label}：${safeTitle}`}
      className={cn(
        "group/canvas-card flex w-full max-w-[min(100%,560px)] items-center gap-3 rounded-lg border border-border/70 bg-card px-3 py-3 text-left shadow-[var(--shadow-card)] transition-all hover:border-foreground/20 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
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
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground ring-1 ring-border/60">
        {kind === "prototype" ? (
          <PanelRightOpenIcon className="size-4" />
        ) : (
          <FileTextIcon className="size-4" />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{label}</span>
          {displayStatus === "streaming" ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-foreground/45 animate-pulse" />
              生成中
            </span>
          ) : null}
        </span>
        <span className="truncate text-sm font-medium leading-snug text-foreground">
          {safeTitle}
        </span>
        <span className="text-xs leading-snug text-muted-foreground">
          点击打开右侧画布
        </span>
      </span>

      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/canvas-card:translate-x-0.5" />
    </button>
  );
}
