"use client";

import type { ArtifactVersionFavoriteListItem } from "@workbench/workbench-contracts";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  StarIcon,
  XIcon,
} from "lucide-react";

import { useInfiniteWorkbenchArtifactVersionFavorites } from "@/lib/workbench/features";
import { cn } from "@/lib/utils";
import { panelTransition, popoverTransition, workbenchEase } from "./workbench-motion";

export function WorkbenchCanvasFavouritesPanel({
  onClose,
  onSelect,
  projectId,
}: {
  onClose: () => void;
  onSelect?: (item: ArtifactVersionFavoriteListItem) => void;
  projectId: string;
}) {
  const query = useInfiniteWorkbenchArtifactVersionFavorites(projectId, { limit: 20 });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const hasNextPage = Boolean(query.hasNextPage);

  return (
    <motion.aside
      animate={{ opacity: 1, scale: 1, x: 0, y: "-50%" }}
      aria-label="Favourites"
      className="absolute right-[80px] top-1/2 z-50 flex max-h-[min(620px,calc(100vh-80px))] w-[324px] flex-col overflow-hidden rounded-[20px] border border-white/[0.12] bg-[#202124]/98 p-[13px] text-[#f1f3f4] shadow-[0_26px_80px_-36px_rgba(0,0,0,0.98)] backdrop-blur-xl max-sm:right-[64px] max-sm:w-[min(324px,calc(100vw-80px))]"
      data-workbench-canvas-favourites-panel
      initial={{ opacity: 0, scale: 0.97, x: 8, y: "-50%" }}
      transition={{ ...panelTransition, ease: workbenchEase }}
    >
      <header className="flex h-[42px] shrink-0 items-center gap-[10px] px-[2px]">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-full bg-[#f1f3f4] text-[#202124]">
          <StarIcon className="size-[17px] fill-current" />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block text-[14px] font-semibold leading-[18px]">Favourites</strong>
          <span className="block text-[13px] leading-[17px] text-[#aeb3bb]">已收藏的界面和产物版本</span>
        </span>
        <button
          aria-label="关闭 Favourites"
          className="grid size-[30px] place-items-center rounded-full text-[#b5bac2] transition-colors hover:bg-white/[0.07] hover:text-white"
          onClick={onClose}
          type="button"
        >
          <XIcon className="size-[16px]" />
        </button>
      </header>

      <div className="mt-[8px] min-h-0 flex-1 overflow-y-auto pr-[2px]">
        {query.isPending ? (
          <div className="grid min-h-[180px] place-items-center text-[#aeb3bb]" role="status">
            <LoaderCircleIcon className="size-[18px] animate-spin" />
          </div>
        ) : query.isError ? (
          <div className="grid min-h-[180px] place-items-center px-[22px] text-center text-[13px] leading-[19px] text-[#b9bec7]" role="alert">
            收藏列表暂时不可用，请重试。
            <button
              className="mt-[10px] inline-flex h-[32px] items-center gap-[6px] rounded-full border border-white/[0.12] px-[12px] text-[13px] font-semibold text-[#f1f3f4] hover:bg-white/[0.07]"
              onClick={() => void query.refetch()}
              type="button"
            >
              重试
              <ArrowUpRightIcon className="size-[14px]" />
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="grid min-h-[180px] place-items-center px-[22px] text-center">
            <div>
              <StarIcon className="mx-auto size-[24px] text-[#858a94]" />
              <p className="mt-[10px] text-[14px] font-semibold text-[#e5e7eb]">No favourites yet</p>
            </div>
          </div>
        ) : (
          <div className="space-y-[7px]">
            <AnimatePresence initial={false}>
              {items.map((item) => (
                <motion.button
                  animate={{ opacity: 1, y: 0 }}
                  className="group flex w-full items-center gap-[10px] rounded-[12px] border border-white/[0.08] bg-[#17181a]/80 p-[10px] text-left transition-colors hover:border-white/[0.18] hover:bg-white/[0.06]"
                  exit={{ opacity: 0, y: -4 }}
                  initial={{ opacity: 0, y: 4 }}
                  key={`${item.artifactVersionId}:${item.screenId ?? "artifact"}`}
                  onClick={() => onSelect?.(item)}
                  transition={popoverTransition}
                  type="button"
                >
                  <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] bg-[#292b31] text-[#c9b3ff]">
                    <StarIcon className="size-[16px] fill-current" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-[#eef0f4]">
                      {item.screenName ?? item.artifactTitle}
                    </span>
                    <span className="mt-[3px] block truncate text-[12px] text-[#9298a2]">
                      {item.screenName ? `${item.artifactTitle} · v${item.artifactVersion}` : `v${item.artifactVersion}`}
                    </span>
                  </span>
                  <ArrowUpRightIcon className="size-[15px] shrink-0 text-[#727883] transition-transform group-hover:-translate-y-[1px] group-hover:translate-x-[1px]" />
                </motion.button>
              ))}
            </AnimatePresence>
            {hasNextPage && (
              <button
                className={cn(
                  "mt-[8px] flex h-[34px] w-full items-center justify-center gap-[6px] rounded-full border border-white/[0.10] text-[13px] font-semibold text-[#d6dae1] hover:bg-white/[0.06]",
                  query.isFetchingNextPage && "cursor-wait opacity-70",
                )}
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
                type="button"
              >
                {query.isFetchingNextPage ? <LoaderCircleIcon className="size-[14px] animate-spin" /> : <ChevronDownIcon className="size-[14px]" />}
                加载更多
              </button>
            )}
          </div>
        )}
      </div>
    </motion.aside>
  );
}
