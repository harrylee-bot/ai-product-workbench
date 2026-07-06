"use client";

import {
  ClapperboardIcon,
  LibraryBigIcon,
  NotebookIcon,
  PanelLeftCloseIcon,
  PenLineIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TrashIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useState } from "react";
import type { ComponentType } from "react";
import { toast } from "sonner";
import { useSWRConfig } from "swr";
import {
  CHAT_HISTORY_KEY,
  SidebarHistory,
} from "@/components/chat/sidebar-history";
import { Sidebar, SidebarRail, useSidebar } from "@/components/ui/sidebar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useAuth, type NestUser } from "@/lib/auth/nest-auth";
import { deleteAllChats } from "@/lib/api/nest-client";
import { createNewChatHref } from "@/lib/chat-navigation";
import { cn } from "@/lib/utils";

type RailAction = {
  id: "new" | "search" | "prototype" | "library";
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const railActions: RailAction[] = [
  { id: "new", label: "发起新对话", icon: PenLineIcon },
  { id: "search", label: "搜索对话内容", icon: SearchIcon },
  { id: "prototype", label: "原型预览", icon: ClapperboardIcon },
  { id: "library", label: "库", icon: LibraryBigIcon },
];

export function AppSidebar({ user: userProp }: { user?: NestUser | undefined }) {
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { setOpenMobile, state, toggleSidebar } = useSidebar();
  const { mutate } = useSWRConfig();
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false);
  const [activeAction, setActiveAction] = useState<RailAction["id"]>("library");
  const [historyQuery, setHistoryQuery] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const { user: authUser, loading: authLoading, logout } = useAuth();

  // 优先用传入的 user（服务端注入），否则回退到 AuthProvider 的当前用户。
  const user = userProp ?? authUser ?? undefined;
  const displayName = user?.displayName || user?.email || user?.username || "用户";
  const initial = displayName.slice(0, 1).toUpperCase();
  const isAdmin = user?.role === "admin";

  const handleDeleteAll = async () => {
    setShowDeleteAllDialog(false);
    router.replace(createNewChatHref());
    mutate(CHAT_HISTORY_KEY, [], {
      revalidate: false,
    });

    try {
      await deleteAllChats();
      await mutate(CHAT_HISTORY_KEY);
      toast.success("已删除全部对话");
    } catch {
      mutate(CHAT_HISTORY_KEY);
      toast.error("删除全部对话失败");
    }
  };

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      router.push("/login");
    } catch {
      toast.error("退出登录失败");
    } finally {
      setSigningOut(false);
    }
  };

  const handleAction = (id: RailAction["id"]) => {
    setActiveAction(id);
    if (id === "new") {
      setOpenMobile(false);
      router.push(createNewChatHref());
      return;
    }
    if (id === "search") {
      setSearchVisible(true);
      if (state === "collapsed") toggleSidebar();
      return;
    }
    if (id === "prototype") {
      toast("原型预览可在生成 Canvas 后打开。");
      return;
    }
    if (id === "library" && state === "collapsed") {
      toggleSidebar();
    }
  };

  return (
    <>
      <Sidebar collapsible="icon">
        <CollapsedRail
          activeAction={activeAction}
          displayName={displayName}
          initial={initial}
          isAdmin={isAdmin}
          onAction={handleAction}
          onOpen={toggleSidebar}
          onSignOut={handleSignOut}
          onThemeToggle={() =>
            setTheme(resolvedTheme === "dark" ? "light" : "dark")
          }
          onDeleteAll={() => setShowDeleteAllDialog(true)}
          routerPushAdmin={() => router.push("/admin")}
          signingOut={signingOut}
          user={user}
        />

        <div className="flex min-h-0 flex-1 flex-col bg-[#1f1f1f] text-[#e8eaed] md:group-data-[state=collapsed]:hidden">
          <div className="flex h-[104px] shrink-0 items-center justify-between px-8 pt-2">
            <div className="flex min-w-0 items-center gap-4">
              <BrandMark className="size-8" />
              <span className="truncate text-[28px] font-medium tracking-[-0.02em]">
                产品工作台
              </span>
            </div>
            <button
              aria-label="收起侧边栏"
              className="flex size-9 items-center justify-center rounded-lg text-[#f1f3f4] transition-colors hover:bg-white/10"
              data-testid="workbench-panel-toggle"
              onClick={toggleSidebar}
              type="button"
            >
              <PanelLeftCloseIcon className="size-6" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pr-2 pb-4 no-scrollbar">
            <nav aria-label="主操作" className="grid gap-1 px-3">
              {railActions.map((item) => (
                <ExpandedActionRow
                  active={activeAction === item.id}
                  icon={item.icon}
                  key={item.id}
                  label={item.label}
                  onClick={() => handleAction(item.id)}
                />
              ))}
              <button
                className="mt-4 flex h-12 items-center gap-6 rounded-full px-4 text-left text-[22px] text-[#a8aaad] transition-colors hover:bg-white/8 hover:text-[#f1f3f4]"
                onClick={() => toast("笔记本会沉淀到本地知识库。")}
                type="button"
              >
                <NotebookIcon className="size-6" />
                <span className="min-w-0 flex-1 truncate">笔记本</span>
                <span className="text-[#a8aaad]">›</span>
              </button>
            </nav>

            {searchVisible ? (
              <div className="px-7 pt-5">
                <label className="flex h-12 items-center gap-3 rounded-full bg-[#2f3030] px-4 text-[#e8eaed]">
                  <SearchIcon className="size-5 shrink-0 text-[#c4c7c5]" />
                  <input
                    aria-label="搜索历史对话"
                    autoFocus
                    className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[#9aa0a6]"
                    onChange={(event) => setHistoryQuery(event.target.value)}
                    placeholder="搜索对话内容"
                    value={historyQuery}
                  />
                </label>
              </div>
            ) : null}

            <div className="px-7 pt-9">
              <div className="mb-4 text-[22px] text-[#9aa0a6]">最近</div>
            </div>
            <SidebarHistory
              flat
              hideLabel
              isAuthLoading={authLoading && !user}
              query={historyQuery}
              user={user}
            />
          </div>

          <div className="flex h-[104px] shrink-0 items-center gap-4 px-5 pb-5">
            {user ? (
              <div className="flex min-w-0 flex-1 items-center gap-4">
                <Avatar initial={initial} />
                <div className="min-w-0">
                  <div
                    className="truncate text-[22px] leading-tight text-[#e8eaed]"
                    data-testid="user-email"
                  >
                    {displayName}
                  </div>
                  <div className="mt-1 truncate text-[16px] text-[#9aa0a6]">
                    Pro
                  </div>
                </div>
              </div>
            ) : null}
            <SettingsMenu
              isAdmin={isAdmin}
              onDeleteAll={() => setShowDeleteAllDialog(true)}
              onSignOut={handleSignOut}
              onThemeToggle={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
              routerPushAdmin={() => router.push("/admin")}
              signingOut={signingOut}
              user={user}
            />
          </div>
        </div>
        <SidebarRail />
      </Sidebar>

      <AlertDialog
        onOpenChange={setShowDeleteAllDialog}
        open={showDeleteAllDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除全部对话？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作无法撤销，将永久删除你的全部对话记录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAll}>
              删除全部
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CollapsedRail({
  activeAction,
  displayName,
  initial,
  isAdmin,
  onAction,
  onDeleteAll,
  onOpen,
  onSignOut,
  onThemeToggle,
  routerPushAdmin,
  signingOut,
  user,
}: {
  activeAction: RailAction["id"];
  displayName: string;
  initial: string;
  isAdmin: boolean;
  onAction: (id: RailAction["id"]) => void;
  onDeleteAll: () => void;
  onOpen: () => void;
  onSignOut: () => void;
  onThemeToggle: () => void;
  routerPushAdmin: () => void;
  signingOut: boolean;
  user?: NestUser;
}) {
  return (
    <nav
      aria-label="产品工作台收起导航"
      className="hidden w-16 shrink-0 flex-col items-center bg-[#111111] px-2 py-8 text-[#f1f3f4] md:group-data-[state=collapsed]:flex"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label="展开侧边栏"
            className="mb-12 flex size-10 items-center justify-center rounded-full transition-transform hover:scale-105"
            data-testid="workbench-rail-toggle"
            onClick={onOpen}
            type="button"
          >
            <BrandMark className="size-8" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">展开侧边栏</TooltipContent>
      </Tooltip>

      <div className="grid gap-6">
        {railActions.map((item) => (
          <RailIconButton
            active={activeAction === item.id}
            icon={item.icon}
            key={item.id}
            label={item.label}
            onClick={() => onAction(item.id)}
          />
        ))}
      </div>

      <div className="mt-auto grid gap-6">
        <SettingsMenu
          compact
          isAdmin={isAdmin}
          onDeleteAll={onDeleteAll}
          onSignOut={onSignOut}
          onThemeToggle={onThemeToggle}
          routerPushAdmin={routerPushAdmin}
          signingOut={signingOut}
          user={user}
        />
        {user ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="账号"
                className="flex size-11 items-center justify-center rounded-full transition-transform hover:scale-105"
                onClick={onOpen}
                type="button"
              >
                <Avatar initial={initial} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{displayName}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </nav>
  );
}

function ExpandedActionRow({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex h-16 items-center gap-6 rounded-full px-6 text-left text-[22px] text-[#e8eaed] transition-colors hover:bg-[#2f3030]",
        active && "bg-[#333333]"
      )}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-7 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function RailIconButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          aria-pressed={active}
          className={cn(
            "flex size-10 items-center justify-center rounded-full text-[#f1f3f4] transition-colors hover:bg-white/10",
            active && "bg-white/10"
          )}
          onClick={onClick}
          type="button"
        >
          <Icon className="size-7" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function SettingsMenu({
  compact,
  isAdmin,
  onDeleteAll,
  onSignOut,
  onThemeToggle,
  routerPushAdmin,
  signingOut,
  user,
}: {
  compact?: boolean;
  isAdmin: boolean;
  onDeleteAll: () => void;
  onSignOut: () => void;
  onThemeToggle: () => void;
  routerPushAdmin: () => void;
  signingOut: boolean;
  user?: NestUser;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="设置"
              className={cn(
                "flex items-center justify-center rounded-full text-[#f1f3f4] transition-colors hover:bg-white/10",
                compact ? "size-10" : "size-11"
              )}
              type="button"
            >
              <SettingsIcon className={compact ? "size-7" : "size-6"} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">设置</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align={compact ? "start" : "end"}
        className="w-52 rounded-xl border-white/10 bg-[#252525]/98 text-[#f1f3f4] shadow-[0_20px_60px_-24px_rgba(0,0,0,0.9)] backdrop-blur-xl"
        side={compact ? "right" : "top"}
      >
        <DropdownMenuItem className="cursor-pointer" onSelect={onThemeToggle}>
          切换深浅色
        </DropdownMenuItem>
        {isAdmin ? (
          <DropdownMenuItem className="cursor-pointer" onSelect={routerPushAdmin}>
            <ShieldCheckIcon className="size-4" />
            系统设置
          </DropdownMenuItem>
        ) : null}
        {user ? (
          <>
            <DropdownMenuItem className="cursor-pointer" onSelect={onDeleteAll}>
              <TrashIcon className="size-4" />
              删除全部对话
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-white/10" />
            <DropdownMenuItem asChild>
              <button
                className="w-full cursor-pointer"
                disabled={signingOut}
                onClick={onSignOut}
                type="button"
              >
                {signingOut ? "正在退出..." : "退出登录"}
              </button>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Avatar({ initial }: { initial: string }) {
  return (
    <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-[#607582] text-[22px] font-medium text-white">
      {initial}
    </span>
  );
}

function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex items-center justify-center rounded-full bg-[conic-gradient(from_180deg,#4f7cff,#53e0a5,#f7d15f,#f05f75,#4f7cff)] text-white shadow-[0_0_20px_rgba(83,224,165,0.22)]",
        className
      )}
    >
      <SparklesIcon className="size-[62%] fill-current stroke-[1.8]" />
    </span>
  );
}
