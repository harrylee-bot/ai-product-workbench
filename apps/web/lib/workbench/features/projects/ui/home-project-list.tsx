"use client";

import {
  CopyIcon,
  MonitorIcon,
  MoreVerticalIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { shouldLoadMoreProjects } from "../application";
import type { WorkbenchHomeProjectItem } from "../domain";

export function HomeProjectList({
  actionBusy,
  error,
  hasNextPage,
  isFetchingNextPage,
  loadStatus,
  onArchiveProject,
  onDuplicateProject,
  onLoadMore,
  onOpenProject,
  onRetry,
  projects,
}: {
  actionBusy: boolean;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  loadStatus: "error" | "loading" | "ready";
  onArchiveProject: (project: WorkbenchHomeProjectItem) => void;
  onDuplicateProject: (project: WorkbenchHomeProjectItem) => void;
  onLoadMore: () => void;
  onOpenProject: (projectId: string) => void;
  onRetry: () => void;
  projects: WorkbenchHomeProjectItem[];
}) {
  const groups: WorkbenchHomeProjectItem["group"][] = ["最近", "昨天", "过去 7 天", "更早", "示例"];

  return (
    <div className="absolute bottom-[16px] left-[28px] right-[16px] top-[123px] overflow-hidden">
      <div
        aria-busy={isFetchingNextPage}
        className="h-full overflow-y-auto pr-[8px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        data-fetching-next-page={isFetchingNextPage ? "true" : undefined}
        data-has-next-page={hasNextPage ? "true" : undefined}
        onScroll={(event) => {
          const target = event.currentTarget;
          if (shouldLoadMoreProjects({
            clientHeight: target.clientHeight,
            hasNextPage,
            isFetchingNextPage,
            scrollHeight: target.scrollHeight,
            scrollTop: target.scrollTop,
          })) onLoadMore();
        }}
      >
        {loadStatus === "loading" && (
          <div className="pt-[58px] text-center text-[13px] font-medium text-[#8f949c]">
            正在加载项目...
          </div>
        )}
        {loadStatus === "error" && (
          <div className="pt-[58px] text-center text-[13px] font-medium text-[#8f949c]">
            <p className="whitespace-normal">{errorMessage(error, "项目列表加载失败")}</p>
            <button
              className="mt-[12px] rounded-full border border-white/[0.10] px-[13px] py-[6px] text-[#d8dce2] hover:bg-white/[0.06]"
              onClick={onRetry}
              type="button"
            >
              重试
            </button>
          </div>
        )}
        {loadStatus === "ready" && groups.map((group) => {
          const groupProjects = projects.filter((project) => project.group === group);
          if (groupProjects.length === 0) return null;

          return (
            <section className="pb-[20px]" key={group}>
              <h2 className="mb-[12px] text-[20px] font-semibold leading-[28px] text-[#cfd3da]">{group}</h2>
              <div className="space-y-[10px]">
                {groupProjects.map((project) => (
                  <div className="group/project relative" key={project.id}>
                    <button
                      className="group flex min-h-[68px] w-full items-center gap-[13px] rounded-[8px] px-[8px] py-[7px] pr-[38px] text-left transition-colors hover:bg-[#5f6368]/90"
                      onClick={() => onOpenProject(project.id)}
                      type="button"
                    >
                      <HomeProjectThumbnail project={project} />
                      <span className="min-w-0 flex-1">
                        <span className="block max-w-[230px] truncate whitespace-normal text-[15px] font-semibold leading-[20px] text-[#f1f3f4]">
                          {project.title}
                        </span>
                        <span className="mt-[4px] flex items-center gap-[7px] text-[11px] font-medium text-[#aeb4bd] group-hover:text-[#d8dce2]">
                          <MonitorIcon className="size-[12px]" />
                          {project.date}
                          {project.shared && (
                            <>
                              <UserIcon className="ml-[3px] size-[13px]" />
                              <span>已分享</span>
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          aria-label={`${project.title} 项目菜单`}
                          className="absolute right-[7px] top-[18px] z-10 grid size-[30px] place-items-center rounded-full text-[#d8dce2] opacity-100 transition hover:bg-white/[0.10] sm:opacity-0 sm:focus:opacity-100 sm:group-hover/project:opacity-100"
                          type="button"
                        >
                          <MoreVerticalIcon className="size-[17px]" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="min-w-[148px] border-white/[0.08] bg-[#18191b]/96 text-[#f1f3f4]"
                      >
                        <DropdownMenuItem
                          disabled={actionBusy}
                          onSelect={() => onDuplicateProject(project)}
                        >
                          <CopyIcon />
                          复制项目
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-white/[0.08]" />
                        <DropdownMenuItem
                          disabled={actionBusy || project.role !== "owner"}
                          onSelect={() => onArchiveProject(project)}
                          variant="destructive"
                        >
                          <Trash2Icon />
                          删除项目
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        {loadStatus === "ready" && projects.length === 0 && (
          <div className="pt-[58px] text-center text-[13px] font-medium text-[#8f949c]">
            没有匹配的项目
          </div>
        )}
      </div>
    </div>
  );
}

function HomeProjectThumbnail({ project }: { project: WorkbenchHomeProjectItem }) {
  return (
    <span
      className="relative grid size-[40px] shrink-0 overflow-hidden rounded-[6px] border border-white/[0.08] bg-[#111214] shadow-[0_12px_30px_-22px_rgba(0,0,0,0.95)]"
      style={{ "--project-accent": project.accent } as CSSProperties}
    >
      {project.variant === "mobile" ? (
        <span className="absolute inset-[4px] rounded-[4px] bg-[#f4f6f8]">
          <span className="absolute left-[9px] right-[9px] top-[5px] h-[10px] rounded-full bg-[var(--project-accent)]" />
          <span className="absolute left-[7px] top-[18px] size-[8px] rounded-full bg-[#ffcf5a]" />
          <span className="absolute bottom-[5px] left-[6px] right-[6px] h-[5px] rounded-full bg-[#2e70ff]" />
        </span>
      ) : project.variant === "light" ? (
        <span className="absolute inset-[4px] rounded-[4px] bg-[#eef5f4]">
          <span className="absolute left-[5px] top-[5px] h-[9px] w-[11px] rounded-[3px] bg-[var(--project-accent)]" />
          <span className="absolute left-[20px] right-[5px] top-[7px] h-[3px] rounded-full bg-[#b8c2c4]" />
          <span className="absolute bottom-[6px] left-[5px] right-[5px] h-[12px] rounded-[3px] bg-white" />
        </span>
      ) : project.variant === "book" ? (
        <span className="absolute inset-[3px] rounded-[4px] bg-[#d8c6a6]">
          <span className="absolute inset-x-[4px] top-[8px] h-[8px] rounded-[2px] bg-white/80" />
          <span className="absolute bottom-[5px] left-[5px] right-[5px] h-[14px] rounded-[2px] bg-[#242016]" />
        </span>
      ) : project.variant === "landscape" ? (
        <span className="absolute inset-0 bg-[linear-gradient(145deg,#23323f,#5ea0bb_56%,#17222a)]">
          <span className="absolute bottom-[7px] left-[5px] h-[13px] w-[22px] rounded-t-full bg-white/22" />
          <span className="absolute right-[6px] top-[7px] size-[5px] rounded-full bg-white/70" />
        </span>
      ) : (
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_18%_70%,var(--project-accent),transparent_36%),linear-gradient(135deg,#090a0c,#20252c_60%,#0d0e10)]">
          <span className="absolute bottom-[7px] left-[6px] right-[6px] h-px bg-white/18" />
          <span className="absolute left-[7px] top-[9px] h-[4px] w-[18px] rounded-full bg-white/14" />
        </span>
      )}
    </span>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
