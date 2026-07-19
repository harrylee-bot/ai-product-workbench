"use client";

import type { PublicShare } from "@workbench/workbench-contracts";
import { FileTextIcon, FrameIcon, GitForkIcon, Share2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  WorkbenchArtifactContent,
  type WorkbenchArtifactReference,
} from "@/components/workbench/workbench-artifact-content";
import { useWorkbenchAuth } from "@/lib/auth/workbench-auth";
import {
  createWorkbenchProjectPath,
  useCreateWorkbenchProjectRemix,
  useWorkbenchIdentityReader,
} from "@/lib/workbench/features";
import { publicSharePreviewEntries } from "@/lib/workbench/features/public-share-preview";
import { cn } from "@/lib/utils";

export function ShareView({
  share,
  token,
}: {
  share: PublicShare;
  token: string;
}) {
  const { user } = useWorkbenchAuth();
  const identityReader = useWorkbenchIdentityReader();
  const createRemix = useCreateWorkbenchProjectRemix(token);
  const artifacts = useMemo(() => publicSharePreviewEntries(share.release), [share.release]);
  const [selectedArtifactKey, setSelectedArtifactKey] = useState(artifacts[0]?.key ?? "");
  const [remixing, setRemixing] = useState(false);
  const [remixFailed, setRemixFailed] = useState(false);
  const selected = artifacts.find((artifact) => artifact.key === selectedArtifactKey)
    ?? artifacts[0];
  const reference = useMemo<WorkbenchArtifactReference | null>(() => selected ? {
    projectId: share.release.projectId,
    artifactId: selected.artifactId,
    artifactVersionId: selected.artifactVersionId,
    ...(selected.screenId === undefined ? {} : { screenId: selected.screenId }),
    shareToken: token,
  } : null, [selected, share.release.projectId, token]);

  const remix = async () => {
    if (!user) {
      window.location.assign(`/login?next=${encodeURIComponent(`/share/${encodeURIComponent(token)}`)}`);
      return;
    }
    setRemixing(true);
    setRemixFailed(false);
    try {
      const identity = await identityReader.getIdentity();
      const result = await createRemix.mutateAsync({
        request: {
          workspaceId: identity.defaultWorkspaceId,
          title: `重混项目 v${share.release.version}`,
        },
      });
      window.location.assign(createWorkbenchProjectPath(result.value.project.id));
    } catch {
      setRemixFailed(true);
      setRemixing(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#111214] text-[#e8eaed]">
      <header className="sticky top-0 z-20 flex h-[64px] items-center justify-between border-b border-white/[0.08] bg-[#18191b]/96 px-[18px] shadow-[0_10px_34px_-28px_rgba(0,0,0,0.95)] backdrop-blur-xl sm:px-[28px]">
        <div className="flex min-w-0 items-center gap-[12px]">
          <span className="grid size-[34px] shrink-0 place-items-center rounded-[8px] bg-[#2b2d31] text-[#d8dce2]">
            <Share2Icon className="size-[17px]" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[14px] font-semibold text-[#f1f3f4]">
              共享项目 · 版本 {share.release.version}
            </h1>
            <p className="mt-[2px] text-[11px] text-[#9aa0a6]">
              只读发布 · {artifacts.length} 个产物
            </p>
          </div>
        </div>
        {share.scope === "remix" && (
          <button
            className="flex h-[34px] items-center gap-[8px] rounded-full bg-[#c9b3ff] px-[15px] text-[13px] font-semibold text-[#241832] disabled:opacity-60"
            disabled={remixing}
            onClick={() => void remix()}
            type="button"
          >
            <GitForkIcon className="size-[15px]" />
            {remixing ? "正在重混..." : "重混项目"}
          </button>
        )}
      </header>

      {remixFailed && (
        <div className="border-b border-[#f2a7a7]/20 bg-[#f2a7a7]/[0.06] px-[20px] py-[9px] text-center text-[12px] text-[#f2a7a7]">
          重混失败，请重试
        </div>
      )}

      <main className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="border-b border-white/[0.08] bg-[#18191b]/70 p-[12px] lg:border-b-0 lg:border-r">
          <div className="mb-[9px] px-[10px] text-[11px] font-semibold text-[#8f949c]">发布内容</div>
          <div className="flex gap-[6px] overflow-x-auto lg:flex-col lg:overflow-visible">
            {artifacts.map((artifact) => {
              const selectedItem = artifact.key === selected?.key;
              const Icon = artifact.kind === "prd" ? FileTextIcon : FrameIcon;
              return (
                <button
                  aria-pressed={selectedItem}
                  className={cn(
                    "flex h-[42px] min-w-[190px] items-center gap-[10px] rounded-[10px] px-[10px] text-left text-[13px] font-semibold transition-colors lg:min-w-0 lg:w-full",
                    selectedItem
                      ? "bg-[#3a2d4b]/82 text-[#f1f3f4]"
                      : "text-[#c7cad0] hover:bg-white/[0.06]",
                  )}
                  key={artifact.key}
                  onClick={() => setSelectedArtifactKey(artifact.key)}
                  type="button"
                >
                  <Icon className="size-[15px] shrink-0" />
                  <span className="truncate">{artifact.title}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-h-[calc(100vh-64px)] bg-[#202124] p-[12px] sm:p-[20px]">
          <div className="h-[calc(100vh-88px)] min-h-[520px] overflow-hidden rounded-[8px] border border-white/[0.10] bg-[#111827] shadow-[0_28px_80px_-35px_rgba(0,0,0,0.95)]">
            {reference ? (
              <WorkbenchArtifactContent reference={reference} />
            ) : (
              <div className="grid h-full place-items-center text-[14px] text-[#aeb3bb]">
                此发布版本没有可预览产物
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
