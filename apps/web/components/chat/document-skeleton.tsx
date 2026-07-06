"use client";

import type { ArtifactKind } from "./artifact";

export const DocumentSkeleton = ({
  artifactKind,
}: {
  artifactKind: ArtifactKind;
}) => {
  return artifactKind === "image" ? (
    <div className="flex h-[calc(100dvh-60px)] w-full flex-col items-center justify-center gap-4">
      <div className="size-96 animate-pulse rounded-lg bg-muted-foreground/10" />
    </div>
  ) : (
    <div className="mx-auto flex w-full max-w-[760px] flex-col px-8 py-10 text-[#e8eaed] md:px-12 md:py-14">
      <div className="mb-8 flex items-center gap-2 text-[13px] text-[#9aa0a6]">
        <span className="size-2 animate-pulse rounded-full bg-[#8ab4f8]" />
        <span>正在生成文档</span>
      </div>
      <div className="mb-7 h-10 w-[58%] overflow-hidden rounded-lg bg-white/[0.08] before:block before:h-full before:w-full before:shimmer" />
      <div className="flex flex-col gap-3">
        <div className="h-4 w-full overflow-hidden rounded bg-white/[0.07] before:block before:h-full before:w-full before:shimmer" />
        <div className="h-4 w-[92%] overflow-hidden rounded bg-white/[0.07] before:block before:h-full before:w-full before:shimmer" />
        <div className="h-4 w-[76%] overflow-hidden rounded bg-white/[0.07] before:block before:h-full before:w-full before:shimmer" />
      </div>
      <div className="mt-9 h-6 w-[38%] overflow-hidden rounded bg-white/[0.08] before:block before:h-full before:w-full before:shimmer" />
      <div className="mt-4 flex flex-col gap-3">
        <div className="h-4 w-[96%] overflow-hidden rounded bg-white/[0.07] before:block before:h-full before:w-full before:shimmer" />
        <div className="h-4 w-[84%] overflow-hidden rounded bg-white/[0.07] before:block before:h-full before:w-full before:shimmer" />
      </div>
    </div>
  );
};
