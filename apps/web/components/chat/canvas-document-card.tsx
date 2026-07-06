"use client";

import {
  ChevronRightIcon,
  FileTextIcon,
  PanelRightOpenIcon,
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

  return (
    <button
      aria-label={`打开${label}：${safeTitle}`}
      className={cn(
        "group/canvas-card flex w-full max-w-[min(100%,520px)] items-center gap-3 rounded-lg border border-border/70 bg-card/90 px-3 py-2.5 text-left shadow-[var(--shadow-card)] backdrop-blur-xl transition-all hover:border-foreground/20 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
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
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/50 text-primary ring-1 ring-border/50">
        {kind === "prototype" ? (
          <PanelRightOpenIcon className="size-4" />
        ) : (
          <FileTextIcon className="size-4" />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium leading-snug text-foreground">
          {safeTitle}
        </span>
        <span className="flex items-center gap-1.5 truncate text-xs leading-snug text-muted-foreground">
          {isStreaming ? (
            <span className="size-1.5 shrink-0 rounded-full bg-primary/70 animate-pulse" />
          ) : null}
          <span className="truncate">{statusText}</span>
        </span>
      </span>

      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/canvas-card:translate-x-0.5" />
    </button>
  );
}
