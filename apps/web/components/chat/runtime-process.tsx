"use client";

import type { LucideIcon } from "lucide-react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  FileTextIcon,
  LoaderCircleIcon,
  PackageIcon,
  SearchIcon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { useArtifact } from "@/hooks/use-artifact";
import type { RuntimeProcessEvent, RuntimeProcessSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type RuntimeArtifactReference = NonNullable<RuntimeProcessEvent["artifact"]>;

export function RuntimeProcessChain({
  runtimeProcess,
}: {
  runtimeProcess?: RuntimeProcessSnapshot;
}) {
  if (!runtimeProcess || runtimeProcess.status === "idle") {
    return null;
  }

  return <RuntimeProcessChainContent runtimeProcess={runtimeProcess} />;
}

function RuntimeProcessChainContent({
  runtimeProcess,
}: {
  runtimeProcess: RuntimeProcessSnapshot;
}) {
  const startedAt =
    runtimeProcess.startedAt ?? firstRuntimeEventTime(runtimeProcess);
  const endedAt = runtimeProcess.endedAt ?? null;
  const isRunning = runtimeProcess.status === "running";
  const elapsedMs = useElapsedMs(startedAt, endedAt, isRunning);
  const elapsedText = startedAt ? formatElapsed(elapsedMs) : undefined;

  const visibleEvents = (runtimeProcess.events ?? []).filter(
    isVisibleRuntimeEvent,
  );
  const events =
    visibleEvents.length > 0 ? visibleEvents : [fallbackRuntimeEvent()];
  const maxVisibleEvents = 24;
  const hiddenCount = Math.max(0, events.length - maxVisibleEvents);
  const eventsToRender = events.slice(-maxVisibleEvents);

  return (
    <ChainOfThought
      className="max-w-[min(100%,720px)] space-y-2"
      defaultOpen={true}
    >
      <ChainOfThoughtHeader className="text-[13px] leading-[1.65]">
        {runtimeHeaderText(runtimeProcess, elapsedText)}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent className="mt-1 space-y-2">
        {hiddenCount > 0 ? (
          <div className="pl-6 text-[11px] leading-[1.6] text-muted-foreground/55">
            还有 {hiddenCount} 条过程记录
          </div>
        ) : null}
        {eventsToRender.map((event) => (
          <RuntimeProcessStep event={event} key={event.id} />
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

function RuntimeProcessStep({ event }: { event: RuntimeProcessEvent }) {
  const { setArtifact } = useArtifact();
  const detail = formatRuntimeEventDetail(event);
  const artifact = event.artifact;
  const canOpenArtifact = canOpenCanvasArtifact(artifact);
  const canOpenDetail = Boolean(detail) && !canOpenArtifact;
  const [isDetailOpen, setIsDetailOpen] = useState(false);

  const openArtifact = (target: HTMLElement) => {
    if (!artifact || !canOpenArtifact) return;
    const boundingBox = target.getBoundingClientRect();
    setArtifact((currentArtifact) => ({
      ...currentArtifact,
      documentId: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      content:
        currentArtifact.documentId === artifact.id
          ? currentArtifact.content
          : "",
      status: "idle",
      isVisible: true,
      boundingBox: {
        left: boundingBox.x,
        top: boundingBox.y,
        width: boundingBox.width,
        height: boundingBox.height,
      },
    }));
  };

  const label = (
    <RuntimeStepLabel
      event={event}
      isActionable={canOpenArtifact || canOpenDetail}
      onClick={(target) => {
        if (canOpenArtifact) {
          openArtifact(target);
          return;
        }
        if (canOpenDetail) {
          setIsDetailOpen(true);
        }
      }}
    />
  );

  return (
    <>
      <ChainOfThoughtStep
        className={cn(
          "text-[12px] leading-[1.6]",
          event.status === "failed" && "text-destructive",
          event.status === "running" &&
            "text-foreground [&>div:first-child>svg]:animate-spin",
        )}
        icon={runtimeEventIcon(event)}
        label={label}
        status={runtimeEventStepStatus(event)}
      />
      {canOpenDetail ? (
        <Dialog onOpenChange={setIsDetailOpen} open={isDetailOpen}>
          <DialogContent className="max-h-[80vh] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-2xl">
            <DialogHeader className="border-b border-border/60 px-5 py-4">
              <DialogTitle className="pr-8 text-sm leading-6">
                {event.label}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {runtimeEventKindLabel(event.kind)} ·{" "}
                {runtimeEventStatusText(event.status)}
              </DialogDescription>
            </DialogHeader>
            <pre className="max-h-[56vh] overflow-auto whitespace-pre-wrap px-5 py-4 text-[12px] leading-relaxed text-muted-foreground">
              {detail}
            </pre>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function RuntimeStepLabel({
  event,
  isActionable,
  onClick,
}: {
  event: RuntimeProcessEvent;
  isActionable: boolean;
  onClick: (target: HTMLElement) => void;
}) {
  const content = (
    <>
      <span className="mt-px shrink-0 text-muted-foreground/55">
        {runtimeEventKindLabel(event.kind)}
      </span>
      <span className="min-w-0 flex-1 break-words">{event.label}</span>
      {isActionable ? (
        <ChevronRightIcon className="mt-1 size-3 shrink-0 text-muted-foreground/45" />
      ) : null}
    </>
  );

  if (!isActionable) {
    return <div className="flex min-w-0 items-start gap-2">{content}</div>;
  }

  return (
    <button
      className="flex min-w-0 w-full items-start gap-2 rounded-md text-left transition-colors hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onClick={(event) => onClick(event.currentTarget)}
      type="button"
    >
      {content}
    </button>
  );
}

export function shouldShowRuntimeProcess(
  runtimeProcess: RuntimeProcessSnapshot | undefined,
  hasAssistantContent: boolean,
) {
  if (!runtimeProcess || runtimeProcess.status === "idle") {
    return false;
  }
  if (runtimeProcess.status === "running") {
    return true;
  }
  if (
    runtimeProcess.status === "failed" ||
    runtimeProcess.status === "cancelled"
  ) {
    return true;
  }
  if (runtimeProcess.events?.some(isVisibleRuntimeEvent)) {
    return true;
  }
  return !hasAssistantContent && Boolean(runtimeProcess.startedAt);
}

function runtimeHeaderText(
  runtimeProcess: RuntimeProcessSnapshot,
  elapsedText?: string,
) {
  const isRunning = runtimeProcess.status === "running";

  if (isRunning) {
    return elapsedText ? `思考中 · 已处理 ${elapsedText}` : "思考中...";
  }

  const label = statusText(runtimeProcess.status);
  if (!elapsedText) {
    return label;
  }
  return runtimeProcess.status === "succeeded"
    ? `已处理 ${elapsedText}`
    : `${label} · 已处理 ${elapsedText}`;
}

function useElapsedMs(
  startedAt?: string,
  endedAt?: string | null,
  isRunning = false,
) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isRunning || !startedAt) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning, startedAt]);

  if (!startedAt) {
    return 0;
  }

  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, end - start);
}

function runtimeEventStepStatus(
  event: RuntimeProcessEvent,
): "complete" | "active" | "pending" {
  if (event.status === "running") return "active";
  if (event.status === "failed") return "active";
  return "complete";
}

function runtimeEventIcon(event: RuntimeProcessEvent): LucideIcon {
  if (event.status === "failed" || event.kind === "error") {
    return AlertCircleIcon;
  }
  if (event.status === "running") {
    return LoaderCircleIcon;
  }
  if (event.kind === "knowledge") return SearchIcon;
  if (event.kind === "tool") return WrenchIcon;
  if (event.kind === "artifact") return PackageIcon;
  if (event.kind === "document") return FileTextIcon;
  if (event.kind === "status") return SparklesIcon;
  return CheckCircle2Icon;
}

function runtimeEventKindLabel(kind: RuntimeProcessEvent["kind"]) {
  switch (kind) {
    case "knowledge":
      return "知识";
    case "tool":
      return "工具";
    case "artifact":
      return "产物";
    case "document":
      return "文档";
    case "error":
      return "错误";
    default:
      return "步骤";
  }
}

function runtimeEventStatusText(status: RuntimeProcessEvent["status"]) {
  if (status === "running") return "执行中";
  if (status === "failed") return "失败";
  return "已完成";
}

function statusText(status?: RuntimeProcessSnapshot["status"]) {
  if (status === "failed") return "生成失败";
  if (status === "cancelled") return "已停止";
  if (status === "succeeded") return "已完成";
  return "思考中...";
}

function formatRuntimeEventDetail(event: RuntimeProcessEvent) {
  const lines: string[] = [];
  if (event.detail) {
    lines.push(event.detail);
  }
  if (event.artifact && !canOpenCanvasArtifact(event.artifact)) {
    lines.push(
      [
        `产物：${event.artifact.title}`,
        `类型：${event.artifact.kind}`,
        `ID：${event.artifact.id}`,
      ].join("\n"),
    );
  }
  if (event.createdAt) {
    lines.push(`时间：${formatRuntimeDate(event.createdAt)}`);
  }
  return lines.join("\n\n").trim();
}

function canOpenCanvasArtifact(artifact?: RuntimeArtifactReference) {
  return artifact?.kind === "text" || artifact?.kind === "prototype";
}

function isVisibleRuntimeEvent(event: RuntimeProcessEvent) {
  return Boolean(event.label?.trim());
}

function firstRuntimeEventTime(runtimeProcess: RuntimeProcessSnapshot) {
  return runtimeProcess.events?.find(isVisibleRuntimeEvent)?.createdAt;
}

function fallbackRuntimeEvent(): RuntimeProcessEvent {
  const createdAt = new Date().toISOString();
  return {
    id: `runtime-fallback:${createdAt}`,
    kind: "status",
    label: "正在处理请求",
    status: "running",
    createdAt,
  };
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatRuntimeDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
