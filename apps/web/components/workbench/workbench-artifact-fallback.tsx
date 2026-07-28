import { cn } from "@/lib/utils";

export type WorkbenchArtifactFallbackPhase = "generating" | "refining" | "complete";
export type WorkbenchArtifactFallbackVariant = "document" | "prototype";

export function workbenchPendingArtifactTitle(
  prompt: string,
  variant: WorkbenchArtifactFallbackVariant,
  index = 0,
) {
  const normalizedPrompt = prompt.replace(/\s+/g, " ").trim();
  const codePoints = Array.from(normalizedPrompt);
  const subject = codePoints.length > 36
    ? `${codePoints.slice(0, 36).join("")}...`
    : normalizedPrompt || "当前请求";

  return variant === "document"
    ? `${subject} · 需求文档`
    : `${subject} · 界面 ${index + 1}`;
}

export function WorkbenchDocumentLoading({
  mode = "blocking",
  phase = "generating",
}: {
  mode?: "blocking" | "refresh";
  phase?: Extract<WorkbenchArtifactFallbackPhase, "generating" | "refining">;
}) {
  if (mode === "refresh") {
    const label = phase === "refining" ? "正在细化：需求文档" : "正在刷新：需求文档";
    return (
      <div
        aria-atomic="true"
        aria-live="polite"
        className="pointer-events-none absolute inset-0"
        data-workbench-artifact-state="refreshing"
        role="status"
      >
        <div className="absolute right-[18px] top-[18px] flex max-w-[calc(100%-36px)] items-center gap-[9px] rounded-[6px] border border-white/[0.10] bg-[#202124]/92 px-[14px] py-[9px] text-[14px] font-semibold text-[#f1f3f4] shadow-[0_16px_48px_-24px_rgba(0,0,0,0.8)]">
          <span aria-hidden="true" className="workbench-artifact-spinner size-[14px] shrink-0 rounded-full border-2 border-current border-t-transparent" />
          <span className="min-w-0 truncate">{label}</span>
        </div>
      </div>
    );
  }

  return <WorkbenchArtifactFallback
    phase={phase}
    title="需求文档"
    variant="document"
  />;
}

export function WorkbenchArtifactFallback({
  phase,
  title,
  variant,
}: {
  phase: WorkbenchArtifactFallbackPhase;
  title: string;
  variant: WorkbenchArtifactFallbackVariant;
}) {
  if (phase === "complete") {
    return (
      <div
        aria-live="polite"
        className="grid h-full w-full place-items-center px-[32px] text-center"
        data-workbench-artifact-state="unavailable"
      >
        <div className="max-w-[430px]">
          <div className="text-[20px] font-semibold text-[#f1f3f4]">产物不可用</div>
          <p className="mt-[10px] text-[14px] leading-[22px] text-[#aeb2b9]">
            {title} 尚无可用的持久化版本，请重新运行生成。
          </p>
        </div>
      </div>
    );
  }

  const label = phase === "refining" ? `正在细化：${title}` : `正在生成：${title}`;

  return (
    <div
      aria-live="polite"
      className="relative h-full w-full overflow-hidden"
      data-workbench-artifact-state="pending"
      data-workbench-artifact-variant={variant}
    >
      <WorkbenchArtifactSkeleton variant={variant} />
      <div className="absolute inset-0 z-10 grid place-items-center px-[24px]">
        <div className={cn(
          "flex min-w-0 max-w-full items-center gap-[10px] rounded-full px-[20px] py-[10px] text-[15px] font-semibold shadow-[0_18px_60px_-30px_rgba(0,0,0,0.65)]",
          variant === "document"
            ? "bg-[#f1f3f0]/88 text-[#303235]"
            : "bg-[#2a2b2e]/88 text-[#f1f3f4]",
        )}>
          <span className="workbench-artifact-spinner size-[15px] shrink-0 rounded-full border-2 border-current border-t-transparent" />
          <span className="min-w-0 truncate">{label}</span>
        </div>
      </div>
    </div>
  );
}

export function WorkbenchArtifactSkeleton({
  variant,
}: {
  variant: WorkbenchArtifactFallbackVariant;
}) {
  const light = variant === "document";
  return (
    <div
      aria-hidden="true"
      className={cn(
        "absolute inset-0 overflow-hidden px-[28px] py-[30px]",
        light ? "bg-[#d2d0ca]" : "bg-[#242629]",
      )}
      data-workbench-artifact-skeleton
    >
      <div className={cn("mb-[32px] h-[22px] w-[48%] rounded-[5px]", light ? "bg-[#303235]/16" : "bg-white/[0.12]")} />
      <div className={cn("mb-[22px] h-[112px] rounded-[8px]", light ? "bg-[#303235]/10" : "bg-white/[0.07]")} />
      <div className="grid grid-cols-2 gap-[18px]">
        {[0, 1, 2, 3].map((item) => (
          <div
            className={cn("h-[128px] rounded-[8px]", light ? "bg-[#303235]/10" : "bg-white/[0.07]")}
            key={item}
          >
            <div className={cn("mx-[18px] mt-[20px] h-[10px] w-[56%] rounded-full", light ? "bg-[#303235]/16" : "bg-white/[0.13]")} />
            <div className={cn("mx-[18px] mt-[14px] h-[8px] w-[76%] rounded-full", light ? "bg-[#303235]/10" : "bg-white/[0.08]")} />
            <div className={cn("mx-[18px] mt-[9px] h-[8px] w-[62%] rounded-full", light ? "bg-[#303235]/10" : "bg-white/[0.08]")} />
          </div>
        ))}
      </div>
    </div>
  );
}
