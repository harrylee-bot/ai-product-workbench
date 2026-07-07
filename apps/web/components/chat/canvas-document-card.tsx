"use client";

import {
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
  const statusText = isStreaming ? `正在生成${label}…` : `已生成${label}`;
  const isOpen = artifact.isVisible && isCurrentArtifact;

  return (
    <button
      aria-label={`打开${label}：${safeTitle}`}
      className={cn(
        // Gemini canvas card: blue card, 26px rounded
        "relative flex w-full max-w-[min(100%,392px)] items-start gap-3.5",
        "overflow-hidden rounded-[26px] border-0 text-left",
        "px-5 py-5 transition-all",
        // selected = blue, unselected = dark gray
        isOpen
          ? "bg-[#1d2a67] text-white"
          : "bg-[#232429] text-[#e8eaed] hover:brightness-110",
        isStreaming && "animate-[canvas-breathe_1.4s_ease-in-out_infinite]",
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
      {/* card icon */}
      <span className="flex size-6 shrink-0 items-center justify-center rounded-[7px] border border-white/72 mt-0.5">
        {kind === "prototype" ? (
          <PanelRightOpenIcon className="size-3.5" />
        ) : (
          <FileTextIcon className="size-3.5" />
        )}
      </span>

      {/* title + status */}
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="truncate text-[16px] font-[500] leading-snug">
          {safeTitle}
        </span>
        <span className="flex items-center gap-1.5 text-[14px] leading-snug text-white/68">
          {isStreaming ? (
            <>
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-white/70" />
              <span>{statusText}</span>
            </>
          ) : (
            <>
              <SquareStackIcon className="size-3 shrink-0 text-white/50" />
              <span>{statusText}</span>
            </>
          )}
        </span>
      </span>

      {/* "Open" badge when canvas is closed */}
      {!isOpen && (
        <span className="absolute right-4 top-1/2 -translate-y-1/2 flex min-w-[64px] h-[38px] items-center justify-center rounded-full bg-[#26358d] text-[15px] font-[500] text-[#e8ecff]">
          打开
        </span>
      )}
    </button>
  );
}
